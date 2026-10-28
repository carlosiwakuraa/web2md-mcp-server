/**
 * Fachada da conversão isolada: pré-checagens baratas na thread principal + execução no pool de workers.
 * O pool padrão é único no processo: todas as tools e lotes compartilham o mesmo teto de conversões.
 */
import { assertHtmlWithinLimits, resolveLimits, type ConversionLimits } from "./guards.js";
import { defaultPoolOptions, WorkerPool } from "./pool.js";
import type { ConvertOutput, ConvertRequest } from "./protocol.js";

export type ConversionPool = WorkerPool<ConvertRequest, ConvertOutput>;

let defaultPool: ConversionPool | undefined;

/** .js no build (dist/), .ts em dev (tsx) e nos testes. */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./convert-worker${ext}`, import.meta.url);
}

export function getConversionPool(): ConversionPool {
  defaultPool ??= new WorkerPool<ConvertRequest, ConvertOutput>(defaultPoolOptions(workerUrl()));
  return defaultPool;
}

/** Cria um pool próprio (testes): mesmo worker real, limites/timeouts injetáveis. */
export function createConversionPool(overrides: Partial<ReturnType<typeof defaultPoolOptions>> = {}): ConversionPool {
  return new WorkerPool<ConvertRequest, ConvertOutput>({ ...defaultPoolOptions(workerUrl()), ...overrides });
}

export interface ConvertInWorkerOptions {
  /** Cancela a conversão (fila ou worker em execução). */
  signal?: AbortSignal;
  /** Pool alternativo (testes). Padrão: o pool global do processo. */
  pool?: ConversionPool;
  /** Limites alternativos (testes). Padrão: constantes + WEB2MD_MAX_HTML_BYTES. */
  limits?: Partial<ConversionLimits>;
}

export interface HtmlTask {
  html: string;
  pageUrl: string;
  mode: "article" | "full";
  includeLinks: boolean;
  wantHeadings: boolean;
}

/** HTML -> Markdown no worker. Rejeita antes de enfileirar se o HTML passa dos limites. */
export function convertHtmlInWorker(task: HtmlTask, opts: ConvertInWorkerOptions = {}): Promise<ConvertOutput> {
  const limits = resolveLimits(opts.limits);
  try {
    assertHtmlWithinLimits(task.html, limits);
  } catch (err) {
    return Promise.reject(err);
  }
  const req: ConvertRequest = {
    kind: "html",
    ...task,
    limits: { maxNodes: limits.maxNodes, maxDepth: limits.maxDepth },
  };
  return (opts.pool ?? getConversionPool()).run(req, opts.signal);
}

/** Markdown nativo -> postProcess (+ headings) no worker. */
export function postProcessInWorker(
  markdown: string,
  wantHeadings: boolean,
  opts: ConvertInWorkerOptions = {},
): Promise<ConvertOutput> {
  return (opts.pool ?? getConversionPool()).run({ kind: "markdown", markdown, wantHeadings }, opts.signal);
}
