/**
 * Semáforo com fila limitada e cancelamento por AbortSignal.
 *
 * `acquire` devolve uma função `release` (idempotente). Com `max` vagas ocupadas a chamada espera na
 * fila (FIFO); com a fila cheia falha na hora (`LimiterError` kind "full"); se o `signal` abortar
 * enquanto espera, a espera é removida e a chamada falha (kind "aborted").
 */
export class LimiterError extends Error {
  constructor(
    readonly kind: "full" | "aborted",
    message: string,
  ) {
    super(message);
    this.name = "LimiterError";
  }
}

export interface Limiter {
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Vagas em uso. */
  readonly active: number;
  /** Chamadas esperando vaga. */
  readonly queued: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: LimiterError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createLimiter(max: number, maxQueue: number): Limiter {
  const capacity = Math.max(1, Math.floor(max));
  const queueCap = Math.max(0, Math.floor(maxQueue));
  let active = 0;
  const queue: Waiter[] = [];

  const makeRelease = (): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      if (next) {
        // A vaga passa direto para o próximo da fila (active não muda).
        if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(makeRelease());
      } else {
        active--;
      }
    };
  };

  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(new LimiterError("aborted", "Operação cancelada"));
      if (active < capacity) {
        active++;
        return Promise.resolve(makeRelease());
      }
      if (queue.length >= queueCap) {
        return Promise.reject(new LimiterError("full", "Fila de conversões cheia"));
      }
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        if (signal) {
          waiter.onAbort = () => {
            const i = queue.indexOf(waiter);
            if (i !== -1) queue.splice(i, 1);
            reject(new LimiterError("aborted", "Operação cancelada"));
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        queue.push(waiter);
      });
    },
  };
}
