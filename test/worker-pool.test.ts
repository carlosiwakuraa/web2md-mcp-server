import { afterEach, describe, expect, it } from "vitest";
import { WorkerPool, type PoolOptions } from "../src/worker/pool.js";

const WORKER = new URL("./helpers/test-worker.mjs", import.meta.url);

interface Req {
  op: "echo" | "sleep" | "spin" | "oom" | "fail" | "crash";
  value?: string;
  ms?: number;
}

const pools: WorkerPool<Req, any>[] = [];
function makePool(overrides: Partial<PoolOptions> = {}): WorkerPool<Req, any> {
  const pool = new WorkerPool<Req, any>({
    workerUrl: WORKER,
    maxWorkers: 2,
    maxQueue: 10,
    taskTimeoutMs: 5000,
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    maxTasksPerWorker: 100,
    idleMs: 60_000,
    ...overrides,
  });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.shutdown()));
});

describe("WorkerPool", () => {
  it("reaproveita o worker entre tarefas sequenciais", async () => {
    const pool = makePool();
    const a = await pool.run({ op: "echo", value: "a" });
    const b = await pool.run({ op: "echo", value: "b" });
    expect(a.value).toBe("a");
    expect(b.threadId).toBe(a.threadId);
    expect(pool.workerCount).toBe(1);
  });

  it("recicla o worker depois de maxTasksPerWorker tarefas", async () => {
    const pool = makePool({ maxTasksPerWorker: 2 });
    const a = await pool.run({ op: "echo" });
    const b = await pool.run({ op: "echo" });
    const c = await pool.run({ op: "echo" });
    expect(b.threadId).toBe(a.threadId);
    expect(c.threadId).not.toBe(a.threadId);
  });

  it("timeout: encerra o worker (terminate) e devolve CONVERSION_TIMEOUT; o pool continua útil", async () => {
    const pool = makePool({ taskTimeoutMs: 150 });
    const started = Date.now();
    await expect(pool.run({ op: "spin" })).rejects.toMatchObject({
      name: "Web2mdError",
      code: "CONVERSION_TIMEOUT",
      message: expect.stringContaining("interrompida"),
    });
    expect(Date.now() - started).toBeLessThan(3000); // loop síncrono infinito foi de fato cortado
    expect(pool.workerCount).toBe(0);
    expect((await pool.run({ op: "echo", value: "ok" })).value).toBe("ok");
  });

  it("OOM no worker vira erro tratável (CONVERSION_LIMIT) e não derruba o processo", async () => {
    const pool = makePool({ resourceLimits: { maxOldGenerationSizeMb: 24 } });
    await expect(pool.run({ op: "oom" })).rejects.toMatchObject({
      code: "CONVERSION_LIMIT",
      message: expect.stringContaining("limite de memória"),
    });
    expect(pool.workerCount).toBe(0);
    expect((await pool.run({ op: "echo", value: "vivo" })).value).toBe("vivo");
  });

  it("crash do worker (exit) vira erro genérico e o worker é descartado", async () => {
    const pool = makePool();
    await expect(pool.run({ op: "crash" })).rejects.toThrow("Falha interna na conversão");
    expect(pool.workerCount).toBe(0);
  });

  it("erro de negócio vindo do worker mantém o código e reaproveita o worker", async () => {
    const pool = makePool();
    const first = await pool.run({ op: "echo" });
    await expect(pool.run({ op: "fail" })).rejects.toMatchObject({ code: "EMPTY_CONTENT", message: "sem conteúdo" });
    const again = await pool.run({ op: "echo" });
    expect(again.threadId).toBe(first.threadId);
  });

  it("AbortSignal durante a execução encerra o worker", async () => {
    const pool = makePool();
    const ac = new AbortController();
    const p = pool.run({ op: "spin" }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    expect(pool.workerCount).toBe(0);
    expect(pool.active).toBe(0);
  });

  it("AbortSignal na fila cancela sem executar", async () => {
    const pool = makePool({ maxWorkers: 1 });
    const ac = new AbortController();
    const running = pool.run({ op: "sleep", ms: 100 });
    const queued = pool.run({ op: "echo" }, ac.signal);
    expect(pool.queued).toBe(1);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    await running;
  });

  it("respeita o teto de conversões simultâneas e enfileira o resto", async () => {
    const pool = makePool({ maxWorkers: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, () => pool.run({ op: "sleep", ms: 60 })));
    // Sobreposição máxima de intervalos [start, end] ≤ 2
    const events = results.flatMap((r) => [
      { t: r.start, d: 1 },
      { t: r.end, d: -1 },
    ]);
    events.sort((x, y) => x.t - y.t || x.d - y.d); // fim antes do início no mesmo instante
    let cur = 0;
    let max = 0;
    for (const e of events) {
      cur += e.d;
      max = Math.max(max, cur);
    }
    expect(max).toBeLessThanOrEqual(2);
    expect(new Set(results.map((r) => r.threadId)).size).toBeLessThanOrEqual(2);
  });

  it("fila cheia devolve 'servidor ocupado' imediatamente", async () => {
    const pool = makePool({ maxWorkers: 1, maxQueue: 1 });
    const a = pool.run({ op: "sleep", ms: 100 });
    const b = pool.run({ op: "echo" });
    await expect(pool.run({ op: "echo" })).rejects.toMatchObject({
      code: "CONVERSION_LIMIT",
      message: expect.stringContaining("Servidor ocupado"),
    });
    await Promise.all([a, b]);
  });
});
