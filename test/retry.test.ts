import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETRY_MAX_DELAY_MS } from "../src/constants.js";
import { Web2mdError } from "../src/errors.js";
import { fetchPage, parseRetryAfter } from "../src/stages/fetch.js";

const OK_HTML = "<!doctype html><html><body><p>ok</p></body></html>";
const ok = () => new Response(OK_HTML, { headers: { "content-type": "text/html" } });
const status = (code: number, headers: Record<string, string> = {}) => new Response("x", { status: code, headers });
const noEnv = {} as NodeJS.ProcessEnv;

/** fetchImpl que devolve as respostas (ou lança os erros) em sequência; repete a última. */
function sequence(steps: Array<() => Response | never>) {
  const calls: string[] = [];
  const fetchImpl = (async (u: string | URL) => {
    calls.push(String(u));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    return step();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function netError(code: string): () => never {
  return () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  };
}

function harness() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 1,
    env: noEnv,
  };
}

async function failure(p: Promise<unknown>): Promise<Web2mdError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Web2mdError);
  return err as Web2mdError;
}

describe("parseRetryAfter", () => {
  it("segundos", () => {
    expect(parseRetryAfter("2", 0)).toBe(2000);
    expect(parseRetryAfter(" 1.5 ", 0)).toBe(1500);
    expect(parseRetryAfter("0", 0)).toBe(0);
  });
  it("data HTTP (relativa ao 'agora')", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:07 GMT", now)).toBe(7000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });
  it("ausente ou inválido", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("", 0)).toBeUndefined();
    expect(parseRetryAfter("logo", 0)).toBeUndefined();
  });
});

describe("fetchPage: retry", () => {
  it.each([429, 502, 503, 504])("repete HTTP %i e respeita Retry-After", async (code) => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(code, { "retry-after": "2" }), ok]);
    const r = await fetchPage("https://example.com/", { fetchImpl, ...h });
    expect(r.kind).toBe("html");
    expect(calls).toHaveLength(2);
    expect(h.sleeps).toEqual([2000]);
  });

  it("Retry-After em data HTTP", async () => {
    const h = harness();
    const now = Date.parse("2026-01-01T00:00:00Z");
    const { fetchImpl } = sequence([() => status(503, { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }), ok]);
    await fetchPage("https://example.com/", { fetchImpl, ...h, now: () => now });
    expect(h.sleeps).toEqual([3000]);
  });

  it("Retry-After igual ao teto ainda é respeitado", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(429, { "retry-after": String(RETRY_MAX_DELAY_MS / 1000) }), ok]);
    const r = await fetchPage("https://example.com/", { fetchImpl, ...h });
    expect(r.kind).toBe("html");
    expect(calls).toHaveLength(2);
    expect(h.sleeps).toEqual([RETRY_MAX_DELAY_MS]);
  });

  it("Retry-After acima do teto: falha na hora, sem espera nem retentativa", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(429, { "retry-after": "120" }), ok]);
    const e = await failure(fetchPage("https://example.com/x", { fetchImpl, ...h }));
    expect(e.code).toBe("HTTP_ERROR");
    expect(e.message.startsWith("Erro HTTP 429 ao acessar https://example.com/x")).toBe(true);
    expect(e.message).toContain("aguardar 120 s");
    expect(calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("Retry-After (data HTTP) acima do teto também não retenta", async () => {
    const h = harness();
    const now = Date.parse("2026-01-01T00:00:00Z");
    const { calls, fetchImpl } = sequence([() => status(503, { "retry-after": "Thu, 01 Jan 2026 00:01:00 GMT" }), ok]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h, now: () => now }));
    expect(e.code).toBe("HTTP_ERROR");
    expect(calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("backoff exponencial com jitter (sem Retry-After)", async () => {
    const hi = harness();
    await fetchPage("https://example.com/", { fetchImpl: sequence([() => status(503), () => status(503), ok]).fetchImpl, ...hi });
    expect(hi.sleeps).toEqual([500, 1000]);

    const lo = harness();
    await fetchPage("https://example.com/", {
      fetchImpl: sequence([() => status(503), () => status(503), ok]).fetchImpl,
      ...lo,
      random: () => 0,
    });
    expect(lo.sleeps).toEqual([250, 500]);
  });

  it("esgota as tentativas (3 no total) e devolve o erro HTTP original", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(503)]);
    const e = await failure(fetchPage("https://example.com/x", { fetchImpl, ...h }));
    expect(e.code).toBe("HTTP_ERROR");
    expect(e.message).toBe("Erro HTTP 503 ao acessar https://example.com/x");
    expect(calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it("não repete 404 nem outros 4xx", async () => {
    for (const code of [400, 401, 403, 404, 410]) {
      const h = harness();
      const { calls, fetchImpl } = sequence([() => status(code)]);
      const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h }));
      expect(e.code).toBe("HTTP_ERROR");
      expect(calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    }
  });

  it("não repete HTTP 500", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(500)]);
    await failure(fetchPage("https://example.com/", { fetchImpl, ...h }));
    expect(calls).toHaveLength(1);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"])("repete erro de rede %s", async (code) => {
    const h = harness();
    const { calls, fetchImpl } = sequence([netError(code), ok]);
    const r = await fetchPage("https://example.com/", { fetchImpl, ...h });
    expect(r.kind).toBe("html");
    expect(calls).toHaveLength(2);
    expect(h.sleeps).toEqual([500]);
  });

  it("erro de rede transitório persistente vira NETWORK_ERROR após 3 tentativas", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([netError("ECONNRESET")]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h }));
    expect(e.code).toBe("NETWORK_ERROR");
    expect(e.message).toContain("ECONNRESET");
    expect(calls).toHaveLength(3);
  });

  it("não repete erros de rede definitivos (ENOTFOUND, ECONNREFUSED)", async () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
      const h = harness();
      const { calls, fetchImpl } = sequence([netError(code)]);
      await failure(fetchPage("https://example.com/", { fetchImpl, ...h }));
      expect(calls).toHaveLength(1);
    }
  });

  it("não repete timeout", async () => {
    const h = harness();
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h }));
    expect(e.code).toBe("TIMEOUT");
    expect(calls).toHaveLength(1);
  });

  it("não repete content-type não suportado", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => new Response("{}", { headers: { "content-type": "application/json" } })]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h }));
    expect(e.code).toBe("UNSUPPORTED_CONTENT_TYPE");
    expect(calls).toHaveLength(1);
  });

  it("repete também a URL alternativa da regra por domínio", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(503), () => new Response("# Doc", { headers: { "content-type": "text/markdown" } })]);
    const r = await fetchPage("https://developer.apple.com/documentation/swiftui/view", { fetchImpl, ...h });
    expect(r.kind).toBe("native-markdown");
    expect(calls).toEqual([
      "https://developer.apple.com/documentation/swiftui/view.md",
      "https://developer.apple.com/documentation/swiftui/view.md",
    ]);
  });
});

describe("fetchPage: fallback da regra de domínio", () => {
  const APPLE = "https://developer.apple.com/documentation/swiftui/view";
  const ALT = `${APPLE}.md`;

  it("429 esgotado na URL reescrita não aciona o fallback", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(429)]);
    const e = await failure(fetchPage(APPLE, { fetchImpl, ...h }));
    expect(e.code).toBe("HTTP_ERROR");
    expect(e.message).toContain("429");
    expect(calls).toEqual([ALT, ALT, ALT]);
  });

  it("429 com Retry-After acima do teto também não aciona o fallback", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(429, { "retry-after": "120" }), ok]);
    await failure(fetchPage(APPLE, { fetchImpl, ...h }));
    expect(calls).toEqual([ALT]);
  });

  it("404 na URL reescrita aciona o fallback para a original", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(404), ok]);
    const r = await fetchPage(APPLE, { fetchImpl, ...h });
    expect(r.kind).toBe("html");
    expect(calls).toEqual([ALT, APPLE]);
  });

  it("content-type não suportado na URL reescrita aciona o fallback", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => new Response("{}", { headers: { "content-type": "application/json" } }), ok]);
    const r = await fetchPage(APPLE, { fetchImpl, ...h });
    expect(r.kind).toBe("html");
    expect(calls).toEqual([ALT, APPLE]);
  });

  it("o fallback tem orçamento próprio: recebe totalMs inteiro, não o que sobrou da URL reescrita", async () => {
    const h = harness();
    let t = 0;
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      timeouts.push(ms);
      return realTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
      const fetchImpl = (async (u: string | URL) => {
        if (String(u) === ALT) {
          t += 9000;
          return status(404);
        }
        return ok();
      }) as typeof fetch;
      await fetchPage(APPLE, { fetchImpl, ...h, timeoutMs: 10_000, now: () => t });
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(timeouts).toEqual([10_000, 10_000]);
  });
});

describe("fetchPage: retry e orçamento de tempo", () => {
  it("não faz novo retry se a espera estoura o orçamento restante", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([() => status(503, { "retry-after": "5" }), ok]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h, timeoutMs: 4000, now: () => 0 }));
    expect(e.code).toBe("HTTP_ERROR");
    expect(calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("falha com TIMEOUT sem chamar o fetch quando o orçamento já acabou", async () => {
    const h = harness();
    const { calls, fetchImpl } = sequence([ok]);
    let t = 0;
    const now = () => {
      const v = t;
      t += 10_000; // cada leitura do relógio avança 10 s
      return v;
    };
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, ...h, timeoutMs: 1000, now }));
    expect(e.code).toBe("TIMEOUT");
    expect(calls).toHaveLength(0);
  });

  it("cada tentativa recebe só o tempo restante (o orçamento é total, não por tentativa)", async () => {
    const h = harness();
    let t = 0;
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      signals.push(init!.signal!);
      t += 1000; // cada tentativa "gasta" 1 s
      return signals.length < 2 ? status(503, { "retry-after": "1" }) : ok();
    }) as typeof fetch;
    await fetchPage("https://example.com/", {
      fetchImpl,
      ...h,
      timeoutMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        h.sleeps.push(ms);
        t += ms;
      },
    });
    expect(h.sleeps).toEqual([1000]);
    expect(signals).toHaveLength(2);
  });
});

describe("fetchPage: retry contra servidor HTTP real", () => {
  let server: http.Server;
  let base: string;
  const hits: Record<string, number> = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      hits[path] = (hits[path] ?? 0) + 1;
      if (path === "/flaky-503") {
        if (hits[path] === 1) {
          res.writeHead(503, { "retry-after": "1" });
          return res.end("later");
        }
      }
      if (path === "/reset") {
        if (hits[path] === 1) return req.socket.destroy();
      }
      if (path === "/gone") {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(OK_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("503 com Retry-After e depois 200", async () => {
    const h = harness();
    const r = await fetchPage(`${base}/flaky-503`, { ...h });
    expect(r.kind).toBe("html");
    expect(hits["/flaky-503"]).toBe(2);
    expect(h.sleeps).toEqual([1000]);
  });

  it("conexão derrubada pelo servidor (reset) e depois 200", async () => {
    const h = harness();
    const r = await fetchPage(`${base}/reset`, { ...h });
    expect(r.kind).toBe("html");
    expect(hits["/reset"]).toBe(2);
    expect(h.sleeps).toHaveLength(1);
  });

  it("404 não é repetido", async () => {
    const h = harness();
    await failure(fetchPage(`${base}/gone`, { ...h }));
    expect(hits["/gone"]).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});
