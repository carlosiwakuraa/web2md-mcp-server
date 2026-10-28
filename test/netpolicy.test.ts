import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_URL_LENGTH } from "../src/constants.js";
import { Web2mdError } from "../src/errors.js";
import { BatchInputSchema } from "../src/schemas/batch-input.js";
import { InputSchema } from "../src/schemas/input.js";
import { fetchPage, maxBodyBytes } from "../src/stages/fetch.js";
import { closeProxyDispatchers } from "../src/stages/proxy.js";
import {
  BLOCKED_CODE,
  BLOCKED_MESSAGE,
  closeGuardedAgents,
  getGuardedLookup,
  isPrivateAddress,
  parseHostList,
  readNetworkPolicy,
  type Resolver,
} from "../src/stages/netpolicy.js";

const OK_HTML = "<!doctype html><html><body><p>ok</p></body></html>";
const ok = () => new Response(OK_HTML, { headers: { "content-type": "text/html" } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const BLOCK = { WEB2MD_BLOCK_PRIVATE_NETWORKS: "1" } as NodeJS.ProcessEnv;
const noSleep = async () => undefined;

async function failure(p: Promise<unknown>): Promise<Web2mdError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Web2mdError);
  return err as Web2mdError;
}

function recorder(steps: Array<(url: string) => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (u: string | URL) => {
    calls.push(String(u));
    return steps[Math.min(calls.length - 1, steps.length - 1)]!(String(u));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// ------------------------------------------------------------------ isPrivateAddress

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "[::1]",
    "isto-nao-e-ip",
  ])("%s é privado", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("%s é público", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("parseHostList", () => {
  it("normaliza esquema, curinga, ponto, porta e caixa", () => {
    expect(parseHostList("Exemplo.com, *.docs.org .api.net https://site.io:8443/x [::1]:80 ")).toEqual([
      "exemplo.com",
      "docs.org",
      "api.net",
      "site.io",
      "::1",
    ]);
  });
  it("vazio e placeholder não resolvido contam como ausente", () => {
    expect(parseHostList(undefined)).toEqual([]);
    expect(parseHostList("  ")).toEqual([]);
    expect(parseHostList("${user_config.allowed}")).toEqual([]);
  });
});

describe("readNetworkPolicy", () => {
  it("tudo desligado por padrão", () => {
    const p = readNetworkPolicy({});
    expect(p).toMatchObject({ blockPrivate: false, allowedHosts: [], blockedHosts: [], allowHttpsDowngrade: false, restricted: false });
  });
  it("aceita 1/true/yes/on e ignora placeholder", () => {
    for (const v of ["1", "true", "YES", "on"]) {
      expect(readNetworkPolicy({ WEB2MD_BLOCK_PRIVATE_NETWORKS: v }).blockPrivate).toBe(true);
    }
    expect(readNetworkPolicy({ WEB2MD_BLOCK_PRIVATE_NETWORKS: "${user_config.x}" }).blockPrivate).toBe(false);
    expect(readNetworkPolicy({ WEB2MD_BLOCK_PRIVATE_NETWORKS: "0" }).blockPrivate).toBe(false);
  });
});

// ------------------------------------------------------------------ bloqueio por nome/IP literal (sem rede)

describe("bloqueio de rede privada: destinos literais", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/x",
    "http://localhost/",
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://LOCALHOST./",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::1]/",
    "http://[::]/",
    "http://10.0.0.5/",
    "http://172.20.1.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.10/",
    "http://0.0.0.0/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://impressora.local/",
    "http://wiki.corp.internal/",
    "https://internal/",
  ])("recusa %s sem abrir conexão", async (target) => {
    const { calls, fetchImpl } = recorder([ok]);
    const e = await failure(fetchPage(target, { fetchImpl, env: BLOCK, sleep: noSleep }));
    expect(e.code).toBe("NETWORK_ERROR");
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(e.message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(calls).toHaveLength(0);
  });

  it("sem a variável, o comportamento padrão continua permitindo (intranet por design)", async () => {
    const { calls, fetchImpl } = recorder([ok]);
    const r = await fetchPage("http://10.0.0.5/", { fetchImpl, env: {} });
    expect(r.kind).toBe("html");
    expect(calls).toEqual(["http://10.0.0.5/"]);
  });

  it("destinos públicos passam", async () => {
    const { calls, fetchImpl } = recorder([ok]);
    await fetchPage("https://example.com/", { fetchImpl, env: BLOCK });
    await fetchPage("http://8.8.8.8/", { fetchImpl, env: BLOCK });
    expect(calls).toEqual(["https://example.com/", "http://8.8.8.8/"]);
  });

  it("redirect para destino privado é bloqueado em cada salto (nome e IP literal)", async () => {
    for (const to of ["http://169.254.169.254/", "http://localhost:9/", "http://[::ffff:127.0.0.1]/", "http://x.internal/"]) {
      const { calls, fetchImpl } = recorder([() => redirect(to), ok]);
      const e = await failure(fetchPage("https://example.com/a", { fetchImpl, env: BLOCK }));
      expect(e.message).toBe(BLOCKED_MESSAGE);
      expect(calls).toEqual(["https://example.com/a"]);
    }
  });

  it("redirect relativo e em cadeia para destino público funciona", async () => {
    const { calls, fetchImpl } = recorder([() => redirect("/b", 301), () => redirect("https://outro.example.org/c", 307), ok]);
    const r = await fetchPage("https://example.com/a", { fetchImpl, env: BLOCK });
    expect(calls).toEqual(["https://example.com/a", "https://example.com/b", "https://outro.example.org/c"]);
    expect(r.finalUrl).toBe("https://outro.example.org/c");
  });
});

describe("com proxy configurado", () => {
  it("só vale a checagem de nome/IP literal da URL; hostnames públicos seguem pelo proxy", async () => {
    const env = { ...BLOCK, HTTPS_PROXY: "http://127.0.0.1:9" } as NodeJS.ProcessEnv;
    const { calls, fetchImpl } = recorder([ok]);
    await failure(fetchPage("https://127.0.0.1/", { fetchImpl, env }));
    await failure(fetchPage("https://wiki.corp.internal/", { fetchImpl, env }));
    expect(calls).toHaveLength(0);
    await fetchPage("https://example.com/", { fetchImpl, env });
    expect(calls).toEqual(["https://example.com/"]);
    await closeProxyDispatchers();
  });
});

// ------------------------------------------------------------------ allowlist / blocklist

describe("allowlist e blocklist de hosts", () => {
  it("allowlist permite só os hosts listados (e subdomínios)", async () => {
    const env = { WEB2MD_ALLOWED_HOSTS: "docs.example.com, .mdn.dev" } as NodeJS.ProcessEnv;
    const { calls, fetchImpl } = recorder([ok]);
    await fetchPage("https://docs.example.com/a", { fetchImpl, env });
    await fetchPage("https://sub.docs.example.com/a", { fetchImpl, env });
    await fetchPage("https://mdn.dev/a", { fetchImpl, env });
    expect(calls).toHaveLength(3);

    for (const bad of ["https://example.com/", "https://evil-docs.example.com.attacker.io/", "https://notmdn.dev/", "http://8.8.8.8/"]) {
      const e = await failure(fetchPage(bad, { fetchImpl, env }));
      expect(e.message).toBe(BLOCKED_MESSAGE);
    }
    expect(calls).toHaveLength(3);
  });

  it("allowlist também vale para redirects", async () => {
    const env = { WEB2MD_ALLOWED_HOSTS: "example.com" } as NodeJS.ProcessEnv;
    const { calls, fetchImpl } = recorder([() => redirect("https://atacante.io/"), ok]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, env }));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(calls).toHaveLength(1);
  });

  it("allowlist não anula o bloqueio de rede privada", async () => {
    const env = { WEB2MD_ALLOWED_HOSTS: "localhost", ...BLOCK } as NodeJS.ProcessEnv;
    const { calls, fetchImpl } = recorder([ok]);
    await failure(fetchPage("http://localhost/", { fetchImpl, env }));
    expect(calls).toHaveLength(0);
  });

  it("blocklist nega hosts específicos (e subdomínios), sem afetar o resto", async () => {
    const env = { WEB2MD_BLOCKED_HOSTS: "ruim.com" } as NodeJS.ProcessEnv;
    const { calls, fetchImpl } = recorder([ok]);
    await failure(fetchPage("https://ruim.com/", { fetchImpl, env }));
    await failure(fetchPage("https://www.ruim.com/", { fetchImpl, env }));
    await fetchPage("https://bom.com/", { fetchImpl, env });
    await fetchPage("https://naoruim.com/", { fetchImpl, env });
    expect(calls).toEqual(["https://bom.com/", "https://naoruim.com/"]);
  });
});

// ------------------------------------------------------------------ downgrade https -> http

describe("redirect https -> http", () => {
  it("é recusado por padrão, sem requisitar o destino http", async () => {
    const { calls, fetchImpl } = recorder([() => redirect("http://example.com/x"), ok]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl, env: {} }));
    expect(e.code).toBe("NETWORK_ERROR");
    expect(e.message).toContain("https:// para http://");
    expect(e.message).toContain("WEB2MD_ALLOW_HTTPS_DOWNGRADE=1");
    expect(calls).toEqual(["https://example.com/"]);
  });

  it("WEB2MD_ALLOW_HTTPS_DOWNGRADE=1 permite", async () => {
    const { calls, fetchImpl } = recorder([() => redirect("http://example.com/x"), ok]);
    const r = await fetchPage("https://example.com/", { fetchImpl, env: { WEB2MD_ALLOW_HTTPS_DOWNGRADE: "1" } });
    expect(r.finalUrl).toBe("http://example.com/x");
    expect(calls).toHaveLength(2);
  });

  it("também vale no meio da cadeia (https -> https -> http)", async () => {
    const { calls, fetchImpl } = recorder([() => redirect("https://b.example.com/"), () => redirect("http://c.example.com/"), ok]);
    await failure(fetchPage("https://example.com/", { fetchImpl, env: {} }));
    expect(calls).toHaveLength(2);
  });

  it("http -> http e http -> https não são downgrade", async () => {
    const { fetchImpl } = recorder([() => redirect("http://b.example.com/"), () => redirect("https://c.example.com/"), ok]);
    const r = await fetchPage("http://example.com/", { fetchImpl, env: {} });
    expect(r.finalUrl).toBe("https://c.example.com/");
  });

  it("redirects demais e esquema não suportado viram erro de rede", async () => {
    const loop = recorder([() => redirect("/loop")]);
    const e = await failure(fetchPage("https://example.com/", { fetchImpl: loop.fetchImpl, env: {} }));
    expect(e.code).toBe("NETWORK_ERROR");
    expect(e.message).toContain("redirecionamentos");
    const ftp = recorder([() => redirect("ftp://example.com/x")]);
    const e2 = await failure(fetchPage("https://example.com/", { fetchImpl: ftp.fetchImpl, env: {} }));
    expect(e2.message).toContain("esquema");
  });
});

// ------------------------------------------------------------------ lookup protegido (DNS rebinding)

describe("lookup protegido", () => {
  const lookupOnce = (lookup: ReturnType<typeof getGuardedLookup>, host: string, all = true) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown; family?: number }>((resolve) =>
      lookup(host, { all }, (err, address, family) => resolve({ err, address, family })),
    );

  it("devolve só endereços validados (all e não-all)", async () => {
    const resolver: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const lookup = getGuardedLookup(readNetworkPolicy(BLOCK, { resolver }));
    expect((await lookupOnce(lookup, "a.test")).address).toEqual([{ address: "93.184.216.34", family: 4 }]);
    const single = await lookupOnce(lookup, "a.test", false);
    expect(single.address).toBe("93.184.216.34");
    expect(single.family).toBe(4);
  });

  it("DNS rebinding: público na 1ª resolução, privado na 2ª", async () => {
    let n = 0;
    const resolver: Resolver = async () => [{ address: n++ === 0 ? "93.184.216.34" : "169.254.169.254", family: 4 }];
    const lookup = getGuardedLookup(readNetworkPolicy(BLOCK, { resolver }));
    expect((await lookupOnce(lookup, "rebind.test")).err).toBeNull();
    const second = await lookupOnce(lookup, "rebind.test");
    expect(second.err?.code).toBe(BLOCKED_CODE);
    expect(second.address).toBeUndefined();
  });

  it("recusa se QUALQUER endereço resolvido for privado", async () => {
    const resolver: Resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ];
    const lookup = getGuardedLookup(readNetworkPolicy(BLOCK, { resolver }));
    expect((await lookupOnce(lookup, "misto.test")).err?.code).toBe(BLOCKED_CODE);
  });

  it("resolvedor padrão (dns.lookup): localhost resolve para loopback e é recusado", async () => {
    const lookup = getGuardedLookup(readNetworkPolicy(BLOCK));
    expect((await lookupOnce(lookup, "localhost")).err?.code).toBe(BLOCKED_CODE);
  });

  it("falha do resolvedor e resposta vazia viram erro de DNS", async () => {
    const failing: Resolver = async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    expect((await lookupOnce(getGuardedLookup(readNetworkPolicy(BLOCK, { resolver: failing })), "x.test")).err?.code).toBe("ENOTFOUND");
    const empty: Resolver = async () => [];
    expect((await lookupOnce(getGuardedLookup(readNetworkPolicy(BLOCK, { resolver: empty })), "x.test")).err?.code).toBe("ENOTFOUND");
  });
});

// ------------------------------------------------------------------ integração (servidor local)

describe("bloqueio na conexão (servidor 127.0.0.1 tratado como 'público' só por injeção)", () => {
  let server: http.Server;
  let port: number;
  const hits: string[] = [];

  // Nomes fictícios resolvidos pelo resolvedor injetado; só 127.0.0.1 conta como "público" no lookup.
  const resolver: Resolver = async (host) => {
    const table: Record<string, Array<{ address: string; family: number }>> = {
      "externo.test": [{ address: "127.0.0.1", family: 4 }],
      "externo2.test": [{ address: "127.0.0.1", family: 4 }],
      "interno.test": [{ address: "10.0.0.5", family: 4 }],
      "misto.test": [
        { address: "127.0.0.1", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    };
    const found = table[host];
    if (!found) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    return found;
  };
  const netHooks = { resolver, isPrivateResolved: (ip: string) => ip !== "127.0.0.1" };
  const opts = () => ({ env: BLOCK, netHooks, sleep: noSleep });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      hits.push(`${req.headers.host}${path}`);
      if (path === "/to-interno") {
        res.writeHead(302, { location: `http://interno.test:${port}/ok` });
        return res.end();
      }
      if (path === "/to-literal") {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` });
        return res.end();
      }
      if (path === "/to-externo2") {
        res.writeHead(302, { location: `http://externo2.test:${port}/ok` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(OK_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await closeGuardedAgents();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("nome que resolve para IP permitido conecta (e mantém o Host original)", async () => {
    hits.length = 0;
    const r = await fetchPage(`http://externo.test:${port}/ok`, opts());
    expect(r.kind).toBe("html");
    expect(hits).toEqual([`externo.test:${port}/ok`]);
  });

  it("nome que resolve para IP privado é bloqueado sem conectar", async () => {
    hits.length = 0;
    const e = await failure(fetchPage(`http://interno.test:${port}/ok`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(hits).toHaveLength(0);
  });

  it("recusa se algum dos IPs resolvidos for privado", async () => {
    hits.length = 0;
    const e = await failure(fetchPage(`http://misto.test:${port}/ok`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(hits).toHaveLength(0);
  });

  it("redirect externo -> interno (por DNS) é bloqueado no salto", async () => {
    hits.length = 0;
    const e = await failure(fetchPage(`http://externo.test:${port}/to-interno`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(hits).toEqual([`externo.test:${port}/to-interno`]);
  });

  it("redirect externo -> 127.0.0.1 literal é bloqueado no salto", async () => {
    hits.length = 0;
    const e = await failure(fetchPage(`http://externo.test:${port}/to-literal`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(hits).toEqual([`externo.test:${port}/to-literal`]);
  });

  it("redirect externo -> outro externo é seguido", async () => {
    hits.length = 0;
    const r = await fetchPage(`http://externo.test:${port}/to-externo2`, opts());
    expect(r.finalUrl).toBe(`http://externo2.test:${port}/ok`);
    expect(hits).toEqual([`externo.test:${port}/to-externo2`, `externo2.test:${port}/ok`]);
  });

  it("host inexistente não é distinguível de bloqueado (mesma mensagem)", async () => {
    const e = await failure(fetchPage(`http://nao-existe.test:${port}/`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
  });

  it("conexão recusada num destino permitido vira a mesma mensagem genérica", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await failure(fetchPage(`http://externo.test:${closedPort}/`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(e.message).not.toContain("ECONNREFUSED");
  });

  it("timeout com a política ativa também é genérico", async () => {
    const slow = http.createServer(() => undefined);
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const slowPort = (slow.address() as AddressInfo).port;
    try {
      const e = await failure(fetchPage(`http://externo.test:${slowPort}/`, { ...opts(), timeoutMs: 150 }));
      expect(e.message).toBe(BLOCKED_MESSAGE);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });

  it("sem a política, as mensagens detalhadas continuam (ECONNREFUSED aparece)", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await failure(fetchPage(`http://127.0.0.1:${closedPort}/`, { env: {}, sleep: noSleep }));
    expect(e.message).toContain("ECONNREFUSED");
  });

  it("alvos literais continuam bloqueados mesmo com o hook (usam a lista real)", async () => {
    hits.length = 0;
    const e = await failure(fetchPage(`http://127.0.0.1:${port}/ok`, opts()));
    expect(e.message).toBe(BLOCKED_MESSAGE);
    expect(hits).toHaveLength(0);
  });
});

describe("sem política: servidor real e redirects manuais", () => {
  it("segue redirects com o fetch embutido e mantém o finalUrl", async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/a") {
        res.writeHead(301, { location: "/b" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(OK_HTML);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const r = await fetchPage(`${base}/a`, { env: {} });
      expect(r.finalUrl).toBe(`${base}/b`);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

// ------------------------------------------------------------------ chardet / limite de corpo

describe("limite e detecção de charset em corpos grandes", () => {
  const bigBody = (bytes: number) => {
    const buf = Buffer.alloc(bytes, 0xe9);
    Buffer.from("<html><body>").copy(buf, 0);
    return buf;
  };
  const respond = (buf: Buffer) =>
    (async () => new Response(buf, { headers: { "content-type": "text/html" } })) as typeof fetch;

  it("20 MB de bytes altos (não-UTF-8) decodificam em menos de 500 ms", async () => {
    const buf = bigBody(20 * 1024 * 1024);
    const env = { WEB2MD_MAX_BODY_MB: "50" } as NodeJS.ProcessEnv;
    const t0 = performance.now();
    const r = await fetchPage("https://example.com/", { fetchImpl: respond(buf), env });
    const elapsed = performance.now() - t0;
    expect(r.kind).toBe("html");
    expect(elapsed).toBeLessThan(500);
  });

  it("padrão de 10 MiB: corpo maior é descartado com o limite na mensagem", async () => {
    const e = await failure(fetchPage("https://example.com/", { fetchImpl: respond(bigBody(11 * 1024 * 1024)), env: {} }));
    expect(e.message).toContain("limite de 10 MB");
  });

  it("WEB2MD_MAX_BODY_MB ajusta o limite (1–50) e a mensagem", async () => {
    const e = await failure(
      fetchPage("https://example.com/", { fetchImpl: respond(bigBody(2 * 1024 * 1024)), env: { WEB2MD_MAX_BODY_MB: "1" } }),
    );
    expect(e.message).toContain("limite de 1 MB");
    const r = await fetchPage("https://example.com/", {
      fetchImpl: respond(bigBody(12 * 1024 * 1024)),
      env: { WEB2MD_MAX_BODY_MB: "15" },
    });
    expect(r.kind).toBe("html");
  });

  it("maxBodyBytes: padrão, valores inválidos e fora da faixa", () => {
    const MB = 1024 * 1024;
    expect(maxBodyBytes({})).toBe(10 * MB);
    expect(maxBodyBytes({ WEB2MD_MAX_BODY_MB: "abc" })).toBe(10 * MB);
    expect(maxBodyBytes({ WEB2MD_MAX_BODY_MB: "${user_config.x}" })).toBe(10 * MB);
    expect(maxBodyBytes({ WEB2MD_MAX_BODY_MB: "0" })).toBe(1 * MB);
    expect(maxBodyBytes({ WEB2MD_MAX_BODY_MB: "999" })).toBe(50 * MB);
    expect(maxBodyBytes({ WEB2MD_MAX_BODY_MB: "25" })).toBe(25 * MB);
  });
});

// ------------------------------------------------------------------ limite de URL

describe("limite de tamanho da URL", () => {
  const long = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;

  it("schema de URL única rejeita com mensagem clara", () => {
    const r = InputSchema.safeParse({ url: long });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(`limite de ${MAX_URL_LENGTH} caracteres`);
    expect(InputSchema.safeParse({ url: `https://example.com/${"a".repeat(100)}` }).success).toBe(true);
    const exact = `https://example.com/${"a".repeat(MAX_URL_LENGTH - "https://example.com/".length)}`;
    expect(exact).toHaveLength(MAX_URL_LENGTH);
    expect(InputSchema.safeParse({ url: exact }).success).toBe(true);
  });

  it("schema do lote rejeita URL longa", () => {
    const r = BatchInputSchema.safeParse({ urls: ["https://example.com/", long] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(`limite de ${MAX_URL_LENGTH} caracteres`);
  });

  it("URL gigante não é ecoada por inteiro nas mensagens de erro do fetch", async () => {
    const e = await failure(fetchPage("x".repeat(100_000)));
    expect(e.code).toBe("INVALID_URL");
    expect(e.message.length).toBeLessThan(500);
  });
});

// ------------------------------------------------------------------ Retry-After exibido

describe("Retry-After na mensagem", () => {
  const retryMsg = async (value: string) => {
    const fetchImpl = (async () => new Response("x", { status: 429, headers: { "retry-after": value } })) as typeof fetch;
    return (await failure(fetchPage("https://example.com/", { fetchImpl, env: {}, sleep: noSleep }))).message;
  };

  it("valores absurdos viram texto legível", async () => {
    const huge = await retryMsg("1" + "0".repeat(30));
    expect(huge).toContain("mais de 24 h");
    expect(huge).not.toMatch(/Infinity|e\+\d+/);
    expect(await retryMsg("7200")).toContain("2 h");
    expect(await retryMsg("120")).toContain("120 s");
  });

  it("valores não numéricos são ignorados (sem aviso)", async () => {
    const msg = await retryMsg("Infinity");
    expect(msg).not.toContain("aguardar");
  });
});
