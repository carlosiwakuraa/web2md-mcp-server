import { describe, expect, it } from "vitest";
import { createLimiter, LimiterError } from "../src/limiter.js";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("createLimiter", () => {
  it("nunca passa do teto de vagas simultâneas e atende a fila em ordem", async () => {
    const limiter = createLimiter(2, 10);
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    const task = async (id: number) => {
      const release = await limiter.acquire();
      order.push(id);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      await tick();
      running--;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => task(i)));
    expect(maxRunning).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it("com a fila cheia falha na hora (kind full)", async () => {
    const limiter = createLimiter(1, 1);
    const r1 = await limiter.acquire();
    const waiting = limiter.acquire(); // ocupa a única vaga da fila
    await expect(limiter.acquire()).rejects.toMatchObject({ kind: "full" });
    r1();
    (await waiting)();
    expect(limiter.active).toBe(0);
  });

  it("abort enquanto espera tira da fila e rejeita (kind aborted); sem vazar vaga", async () => {
    const limiter = createLimiter(1, 5);
    const r1 = await limiter.acquire();
    const ac = new AbortController();
    const waiting = limiter.acquire(ac.signal);
    expect(limiter.queued).toBe(1);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(LimiterError);
    expect(limiter.queued).toBe(0);
    r1();
    expect(limiter.active).toBe(0);
    // signal já abortado nem entra
    await expect(limiter.acquire(ac.signal)).rejects.toMatchObject({ kind: "aborted" });
  });

  it("release é idempotente", async () => {
    const limiter = createLimiter(1, 1);
    const release = await limiter.acquire();
    release();
    release();
    expect(limiter.active).toBe(0);
    const r2 = await limiter.acquire();
    const r3p = limiter.acquire();
    release(); // release antigo não pode liberar a vaga de r2
    await tick();
    expect(limiter.queued).toBe(1);
    r2();
    (await r3p)();
  });
});
