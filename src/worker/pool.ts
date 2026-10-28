/**
 * Pool de worker_threads para a conversão pesada.
 *
 * Por que pool reutilizável (e não um worker por tarefa): subir o worker custa o carregamento de
 * jsdom/turndown (centenas de ms); reutilizá-lo deixa a conversão de páginas pequenas rápida. Um worker é
 * DESCARTADO (terminate) após timeout, cancelamento, OOM ou crash, e reciclado a cada `maxTasksPerWorker`
 * tarefas ou depois de `idleMs` ocioso, então estado ruim/memória acumulada não se perpetua.
 *
 * Concorrência: um semáforo (src/limiter.ts) com `maxWorkers` vagas e fila limitada; cada vaga ocupa no
 * máximo um worker, então o pool nunca passa de `maxWorkers`.
 *
 * Falhas viram Web2mdError tratável; nada aqui derruba o processo principal (o evento 'error' dos
 * workers sempre tem listener).
 */
import { Worker, type ResourceLimits } from "node:worker_threads";
import {
  CONVERSION_MAX_OLD_GEN_MB,
  CONVERSION_TIMEOUT_MS,
  MAX_CONCURRENT_CONVERSIONS,
  MAX_QUEUED_CONVERSIONS,
  WORKER_IDLE_MS,
  WORKER_MAX_TASKS,
} from "../constants.js";
import { Web2mdError, type ErrorCode } from "../errors.js";
import { createLimiter, LimiterError, type Limiter } from "../limiter.js";
import { conversionErrors } from "./conversion-errors.js";
import type { WorkerErrorPayload, WorkerResponse } from "./protocol.js";

export interface PoolOptions {
  /** Arquivo do worker (.js no build, .ts em dev/testes). */
  workerUrl: URL;
  maxWorkers: number;
  maxQueue: number;
  taskTimeoutMs: number;
  resourceLimits: ResourceLimits;
  maxTasksPerWorker: number;
  idleMs: number;
}

interface Slot {
  worker: Worker;
  tasks: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Em dev (.ts) o worker precisa do loader tsx; no build (.js) não precisa de nada. */
function execArgvFor(workerUrl: URL): string[] | undefined {
  if (!workerUrl.pathname.endsWith(".ts")) return undefined;
  let tsx = "tsx";
  try {
    tsx = import.meta.resolve("tsx");
  } catch {
    // mantém "tsx": resolvido a partir do cwd
  }
  return ["--import", tsx];
}

function fromPayload(payload: WorkerErrorPayload): Error {
  switch (payload.type) {
    case "web2md":
      return new Web2mdError(payload.code as ErrorCode, payload.message);
    case "stack-overflow":
      return conversionErrors.stackOverflow();
    case "internal":
      console.error("[web2md] erro interno no worker de conversão:", payload.detail);
      return new Error("Falha interna na conversão");
  }
}

export class WorkerPool<Req, Res> {
  private readonly limiter: Limiter;
  private readonly idle: Slot[] = [];
  private readonly all = new Set<Slot>();

  constructor(private readonly opts: PoolOptions) {
    this.limiter = createLimiter(opts.maxWorkers, opts.maxQueue);
  }

  get active(): number {
    return this.limiter.active;
  }
  get queued(): number {
    return this.limiter.queued;
  }
  get workerCount(): number {
    return this.all.size;
  }

  /** Executa `req` num worker. Rejeita com Web2mdError (timeout, limite, cancelamento) ou Error genérico. */
  async run(req: Req, signal?: AbortSignal): Promise<Res> {
    if (signal?.aborted) throw conversionErrors.aborted();
    let release: () => void;
    try {
      release = await this.limiter.acquire(signal);
    } catch (err) {
      if (err instanceof LimiterError) throw err.kind === "full" ? conversionErrors.busy() : conversionErrors.aborted();
      throw err;
    }
    try {
      if (signal?.aborted) throw conversionErrors.aborted();
      const slot = this.idle.pop() ?? this.spawn();
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      return await this.exec(slot, req, signal);
    } finally {
      release();
    }
  }

  /** Encerra todos os workers (usado em testes e no desligamento). */
  async shutdown(): Promise<void> {
    const slots = [...this.all];
    this.idle.length = 0;
    await Promise.all(slots.map((s) => this.discard(s)));
  }

  private spawn(): Slot {
    const worker = new Worker(this.opts.workerUrl, {
      resourceLimits: this.opts.resourceLimits,
      execArgv: execArgvFor(this.opts.workerUrl),
      // stdout do worker NUNCA vai ao stdout do processo (pertence ao protocolo MCP): é descartado.
      stdout: true,
      stderr: false,
    });
    worker.stdout.resume();
    const slot: Slot = { worker, tasks: 0 };
    this.all.add(slot);
    // Sem listener, um 'error' do worker (ex.: OOM) viraria exceção no processo principal.
    worker.on("error", () => {});
    worker.on("exit", () => {
      this.all.delete(slot);
      const i = this.idle.indexOf(slot);
      if (i !== -1) this.idle.splice(i, 1);
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
    });
    worker.unref();
    return slot;
  }

  private discard(slot: Slot): Promise<unknown> {
    this.all.delete(slot);
    const i = this.idle.indexOf(slot);
    if (i !== -1) this.idle.splice(i, 1);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    return slot.worker.terminate().catch(() => undefined);
  }

  private giveBack(slot: Slot): void {
    slot.tasks++;
    if (slot.tasks >= this.opts.maxTasksPerWorker) {
      void this.discard(slot);
      return;
    }
    this.idle.push(slot);
    slot.idleTimer = setTimeout(() => void this.discard(slot), this.opts.idleMs);
    slot.idleTimer.unref();
  }

  private exec(slot: Slot, req: Req, signal?: AbortSignal): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const { worker } = slot;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
        worker.unref();
      };
      const finish = (action: () => void, keep: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (keep) this.giveBack(slot);
        else void this.discard(slot);
        action();
      };

      const onMessage = (msg: WorkerResponse<Res>): void => {
        if (msg.ok) finish(() => resolve(msg.result), true);
        // O worker sobreviveu a um erro "de negócio": segue reutilizável.
        else finish(() => reject(fromPayload(msg.error)), true);
      };
      const onError = (err: Error & { code?: string }): void => {
        if (err.code === "ERR_WORKER_OUT_OF_MEMORY") finish(() => reject(conversionErrors.memory()), false);
        else {
          console.error("[web2md] worker de conversão falhou:", err.message);
          finish(() => reject(new Error("Falha interna na conversão")), false);
        }
      };
      const onExit = (): void => {
        console.error("[web2md] worker de conversão encerrou inesperadamente");
        finish(() => reject(new Error("Falha interna na conversão")), false);
      };
      const onAbort = (): void => finish(() => reject(conversionErrors.aborted()), false);

      const timer = setTimeout(
        () => finish(() => reject(conversionErrors.timeout(this.opts.taskTimeoutMs)), false),
        this.opts.taskTimeoutMs,
      );

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.ref(); // enquanto há tarefa em andamento o processo não pode encerrar
      worker.postMessage(req);
    });
  }
}

/** Opções padrão do pool de conversão (constantes de src/constants.ts). */
export function defaultPoolOptions(workerUrl: URL): PoolOptions {
  return {
    workerUrl,
    maxWorkers: MAX_CONCURRENT_CONVERSIONS,
    maxQueue: MAX_QUEUED_CONVERSIONS,
    taskTimeoutMs: CONVERSION_TIMEOUT_MS,
    resourceLimits: { maxOldGenerationSizeMb: CONVERSION_MAX_OLD_GEN_MB },
    maxTasksPerWorker: WORKER_MAX_TASKS,
    idleMs: WORKER_IDLE_MS,
  };
}
