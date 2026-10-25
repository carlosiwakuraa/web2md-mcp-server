import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Web2mdError } from "../src/errors.js";
import { fetchPage } from "../src/stages/fetch.js";
import {
  closeProxyDispatchers,
  getProxyDispatcher,
  matchesNoProxy,
  parseNoProxy,
  readProxyEnv,
  redactSecrets,
  selectProxy,
} from "../src/stages/proxy.js";

const OK_HTML = "<!doctype html><html><body><p>via proxy</p></body></html>";
const noSleep = async () => undefined;

function sel(url: string, env: NodeJS.ProcessEnv) {
  return selectProxy(new URL(url), readProxyEnv(env));
}

describe("readProxyEnv", () => {
  it("lê as variáveis em maiúsculas e minúsculas (minúscula tem precedência)", () => {
    const a = readProxyEnv({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2", NO_PROXY: "x.com" });
    expect(a).toMatchObject({ httpsProxy: "http://a:1", httpProxy: "http://b:2", noProxy: "x.com" });
    const b = readProxyEnv({ HTTPS_PROXY: "http://a:1", https_proxy: "http://lower:9" });
    expect(b.httpsProxy).toBe("http://lower:9");
  });

  it("trata vazio e só espaços como não definido (manifest .mcpb injeta HTTPS_PROXY vazio)", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const env = readProxyEnv({
        HTTPS_PROXY: blank,
        https_proxy: blank,
        HTTP_PROXY: blank,
        http_proxy: blank,
        NO_PROXY: blank,
        no_proxy: blank,
      });
      expect(env.httpsProxy).toBeUndefined();
      expect(env.httpProxy).toBeUndefined();
      expect(env.noProxy).toBeUndefined();
      expect(getProxyDispatcher(env)).toBeUndefined();
      expect(sel("https://example.com/", { HTTPS_PROXY: blank })).toBeNull();
    }
  });

  it("ignora placeholder não resolvido do manifest (${user_config.xxx}), com ou sem espaços", () => {
    for (const ph of ["${user_config.https_proxy}", "  ${user_config.https_proxy}  ", "${"]) {
      const env = readProxyEnv({
        HTTPS_PROXY: ph,
        https_proxy: ph,
        HTTP_PROXY: ph,
        http_proxy: ph,
        NO_PROXY: ph,
        no_proxy: ph,
      });
      expect(env.httpsProxy).toBeUndefined();
      expect(env.httpProxy).toBeUndefined();
      expect(env.noProxy).toBeUndefined();
      expect(getProxyDispatcher(env)).toBeUndefined();
      expect(sel("https://example.com/", { HTTPS_PROXY: ph })).toBeNull();
    }
  });

  it("placeholder cai para a outra grafia válida; valor válido continua sendo lido", () => {
    expect(readProxyEnv({ https_proxy: "${user_config.https_proxy}", HTTPS_PROXY: "http://a:1" }).httpsProxy).toBe(
      "http://a:1",
    );
    expect(readProxyEnv({ HTTPS_PROXY: "  http://a:1  " }).httpsProxy).toBe("http://a:1");
    expect(readProxyEnv({ HTTPS_PROXY: "proxy.local:3128" }).httpsProxy).toBe("proxy.local:3128");
  });

  it("minúscula vazia cai para a maiúscula definida", () => {
    expect(readProxyEnv({ https_proxy: "  ", HTTPS_PROXY: "http://a:1" }).httpsProxy).toBe("http://a:1");
  });

  it("sem variáveis, não há dispatcher (comportamento idêntico ao anterior)", async () => {
    let init: (RequestInit & { dispatcher?: unknown }) | undefined;
    const fetchImpl = (async (_u: unknown, i?: RequestInit) => {
      init = i;
      return new Response(OK_HTML, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    await fetchPage("https://example.com/", { fetchImpl, env: { HTTPS_PROXY: "" } });
    expect(init?.dispatcher).toBeUndefined();
  });

  it("com proxy definido, repassa um dispatcher ao fetch", async () => {
    let init: (RequestInit & { dispatcher?: unknown }) | undefined;
    const fetchImpl = (async (_u: unknown, i?: RequestInit) => {
      init = i;
      return new Response(OK_HTML, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    await fetchPage("https://example.com/", { fetchImpl, env: { HTTPS_PROXY: "http://127.0.0.1:9" } });
    expect(init?.dispatcher).toBeDefined();
    await closeProxyDispatchers();
  });
});

describe("NO_PROXY", () => {
  const m = (url: string, raw: string) => matchesNoProxy(new URL(url), parseNoProxy(raw));

  it("vazio ou indefinido não casa com nada", () => {
    expect(parseNoProxy(undefined)).toEqual([]);
    expect(parseNoProxy("")).toEqual([]);
    expect(m("https://example.com/", "")).toBe(false);
  });

  it("'*' desativa o proxy para tudo", () => {
    expect(m("https://example.com/", "*")).toBe(true);
    expect(m("http://10.0.0.1:81/", "foo.com, *")).toBe(true);
  });

  it("host exato e sufixo de domínio (com ou sem ponto / curinga)", () => {
    expect(m("https://example.com/", "example.com")).toBe(true);
    expect(m("https://api.example.com/", "example.com")).toBe(true);
    expect(m("https://api.example.com/", ".example.com")).toBe(true);
    expect(m("https://api.example.com/", "*.example.com")).toBe(true);
    expect(m("https://notexample.com/", "example.com")).toBe(false);
    expect(m("https://example.com.br/", "example.com")).toBe(false);
    expect(m("https://EXAMPLE.com/", "Example.COM")).toBe(true);
  });

  it("separadores por vírgula e espaço", () => {
    expect(m("https://b.org/", "a.com,  b.org c.net")).toBe(true);
    expect(m("https://c.net/", "a.com,  b.org c.net")).toBe(true);
    expect(m("https://d.io/", "a.com,  b.org c.net")).toBe(false);
  });

  it("host:porta exige a mesma porta (inclusive a padrão do esquema)", () => {
    expect(m("http://internal.local:8080/", "internal.local:8080")).toBe(true);
    expect(m("http://internal.local:9090/", "internal.local:8080")).toBe(false);
    expect(m("http://internal.local/", "internal.local:8080")).toBe(false);
    expect(m("https://internal.local/", "internal.local:443")).toBe(true);
    expect(m("http://sub.internal.local:8080/", ".internal.local:8080")).toBe(true);
  });

  it("IPs literais casam por igualdade (IPv4 e IPv6)", () => {
    expect(m("http://127.0.0.1:3000/", "127.0.0.1")).toBe(true);
    expect(m("http://127.0.0.1:3000/", "127.0.0.1:3000")).toBe(true);
    expect(m("http://127.0.0.1:3000/", "127.0.0.1:3001")).toBe(false);
    expect(m("http://127.0.0.2/", "127.0.0.1")).toBe(false);
    expect(m("http://[::1]:8080/", "[::1]:8080")).toBe(true);
    expect(m("http://[::1]/", "::1")).toBe(true);
  });
});

describe("selectProxy", () => {
  it("escolhe HTTPS_PROXY para https e HTTP_PROXY para http", () => {
    const env = { HTTPS_PROXY: "http://sec:8443", HTTP_PROXY: "http://plain:3128" };
    expect(sel("https://example.com/", env)?.label).toBe("sec:8443");
    expect(sel("http://example.com/", env)?.label).toBe("plain:3128");
  });

  it("não usa o proxy do outro esquema", () => {
    expect(sel("https://example.com/", { HTTP_PROXY: "http://plain:3128" })).toBeNull();
    expect(sel("http://example.com/", { HTTPS_PROXY: "http://sec:8443" })).toBeNull();
  });

  it("NO_PROXY ignora o proxy", () => {
    const env = { HTTPS_PROXY: "http://p:1", NO_PROXY: ".corp.local,localhost:3000" };
    expect(sel("https://wiki.corp.local/", env)).toBeNull();
    expect(sel("https://localhost:3000/", env)).toBeNull();
    expect(sel("https://example.com/", env)?.label).toBe("p:1");
  });

  it("aceita proxy sem esquema e usa a porta padrão no rótulo", () => {
    expect(sel("https://example.com/", { HTTPS_PROXY: "meuproxy:3128" })?.url).toBe("http://meuproxy:3128/");
    expect(sel("https://example.com/", { HTTPS_PROXY: "http://meuproxy" })?.label).toBe("meuproxy:80");
  });

  it("o rótulo nunca contém credenciais", () => {
    const c = sel("https://example.com/", { HTTPS_PROXY: "http://us%40er:p%3Ass@proxy.corp:3128" });
    expect(c?.label).toBe("proxy.corp:3128");
    expect(c?.url).toContain("proxy.corp:3128");
  });

  it("valor inválido vira PROXY_ERROR em português, sem vazar o valor", () => {
    let err: unknown;
    try {
      sel("https://example.com/", { HTTPS_PROXY: "http://user:segredo@" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Web2mdError);
    expect((err as Web2mdError).code).toBe("PROXY_ERROR");
    expect((err as Web2mdError).message).toContain("HTTPS_PROXY");
    expect((err as Web2mdError).message).not.toContain("segredo");
    expect(() => sel("https://example.com/", { HTTPS_PROXY: "ftp://proxy:21" })).toThrow(Web2mdError);
  });
});

describe("redactSecrets", () => {
  it("mascara user:pass@ em qualquer URL", () => {
    expect(redactSecrets("falha em http://joao:s3nha@proxy:3128/x e https://a@b.com")).toBe(
      "falha em http://***@proxy:3128/x e https://***@b.com",
    );
  });

  it("mascara usuário, senha e o token Basic conhecidos, mesmo fora de uma URL", () => {
    const env = readProxyEnv({ HTTPS_PROXY: "http://joao:s3nha@proxy:3128" });
    const token = Buffer.from("joao:s3nha").toString("base64");
    const out = redactSecrets(`erro: senha s3nha, usuario joao, Basic ${token}`, env);
    expect(out).not.toContain("s3nha");
    expect(out).not.toContain("joao");
    expect(out).not.toContain(token);
  });

  it("não altera texto sem segredos", () => {
    expect(redactSecrets("ECONNREFUSED 127.0.0.1:3128")).toBe("ECONNREFUSED 127.0.0.1:3128");
  });
});

// ------------------------------------------------------- integração (servidores locais)

describe("fetchPage através de proxy", () => {
  let target: http.Server;
  let proxy: http.Server;
  let denyProxy: http.Server;
  let targetBase: string;
  let proxyUrl: string;
  let denyUrl: string;
  const targetHits: string[] = [];
  const proxySeen: Array<{ url: string; auth?: string; host?: string }> = [];
  let denyStatus = 407;
  const connects: string[] = [];

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      targetHits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(OK_HTML.replace("via proxy", "direto"));
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

    // Proxy "forward": recebe a URL absoluta na linha de requisição e responde ele mesmo.
    proxy = http.createServer((req, res) => {
      proxySeen.push({
        url: req.url ?? "",
        auth: req.headers["proxy-authorization"] as string | undefined,
        host: req.headers.host,
      });
      if ((req.url ?? "").endsWith("/slow")) return; // nunca responde
      if ((req.url ?? "").endsWith("/redirect")) {
        res.writeHead(302, { location: "http://alvo.test/final" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(OK_HTML);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    // Proxy que recusa: 407 (ou outro status) para requisições e para CONNECT.
    denyProxy = http.createServer((_req, res) => {
      res.writeHead(denyStatus, { "proxy-authenticate": 'Basic realm="corp"' });
      res.end();
    });
    denyProxy.on("connect", (req, socket) => {
      connects.push(req.url ?? "");
      socket.end(`HTTP/1.1 ${denyStatus} Nope\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((r) => denyProxy.listen(0, "127.0.0.1", r));
    denyUrl = `127.0.0.1:${(denyProxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await closeProxyDispatchers();
    for (const s of [target, proxy, denyProxy]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  const base = { sleep: noSleep, random: () => 1 };

  it("envia alvos http:// pelo proxy, com Proxy-Authorization vindo das credenciais da URL", async () => {
    proxySeen.length = 0;
    const r = await fetchPage("http://alvo.test/pagina?q=1", {
      ...base,
      env: { HTTP_PROXY: `http://usuario:s3cr3t@${proxyUrl}` },
    });
    expect(r.kind).toBe("html");
    expect(r.kind === "html" && r.html).toContain("via proxy");
    expect(proxySeen).toHaveLength(1);
    expect(proxySeen[0]?.url).toBe("http://alvo.test/pagina?q=1");
    expect(proxySeen[0]?.host).toBe("alvo.test");
    expect(proxySeen[0]?.auth).toBe(`Basic ${Buffer.from("usuario:s3cr3t").toString("base64")}`);
  });

  it("segue redirects também pelo proxy", async () => {
    proxySeen.length = 0;
    const r = await fetchPage("http://alvo.test/redirect", { ...base, env: { HTTP_PROXY: `http://${proxyUrl}` } });
    expect(r.finalUrl).toBe("http://alvo.test/final");
    expect(proxySeen.map((p) => p.url)).toEqual(["http://alvo.test/redirect", "http://alvo.test/final"]);
  });

  it("timeout através do proxy continua virando TIMEOUT (e não é repetido)", async () => {
    const err = await fetchPage("http://alvo.test/slow", {
      ...base,
      timeoutMs: 200,
      env: { HTTP_PROXY: `http://${proxyUrl}` },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Web2mdError).code).toBe("TIMEOUT");
  });

  it("NO_PROXY faz a conexão ir direto ao destino", async () => {
    proxySeen.length = 0;
    targetHits.length = 0;
    const r = await fetchPage(`${targetBase}/direto`, {
      ...base,
      env: { HTTP_PROXY: `http://${proxyUrl}`, NO_PROXY: "127.0.0.1" },
    });
    expect(r.kind === "html" && r.html).toContain("direto");
    expect(targetHits).toEqual(["/direto"]);
    expect(proxySeen).toHaveLength(0);
  });

  it("NO_PROXY com host:porta só ignora o proxy nessa porta", async () => {
    proxySeen.length = 0;
    const port = new URL(targetBase).port;
    await fetchPage(`${targetBase}/a`, {
      ...base,
      env: { HTTP_PROXY: `http://${proxyUrl}`, NO_PROXY: `127.0.0.1:${port}` },
    });
    expect(proxySeen).toHaveLength(0);
    await fetchPage(`${targetBase}/b`, {
      ...base,
      env: { HTTP_PROXY: `http://${proxyUrl}`, NO_PROXY: `127.0.0.1:${Number(port) + 1}` },
    });
    expect(proxySeen.map((p) => p.url)).toEqual([`${targetBase}/b`]);
  });

  it("ECONNREFUSED no proxy vira PROXY_ERROR, sem credenciais na mensagem, e não é repetido", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    const sleeps: number[] = [];
    const err = await fetchPage("http://alvo.test/", {
      sleep: async (ms) => void sleeps.push(ms),
      env: { HTTP_PROXY: `http://admin:hunter2@127.0.0.1:${port}` },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Web2mdError);
    const e = err as Web2mdError;
    expect(e.code).toBe("PROXY_ERROR");
    expect(e.message).toContain(`127.0.0.1:${port}`);
    expect(e.message).toContain("proxy");
    expect(e.message).toContain("ECONNREFUSED");
    expect(e.message).not.toContain("hunter2");
    expect(e.message).not.toContain("admin");
    expect(sleeps).toEqual([]);
  });

  it("407 do proxy (alvo http) vira PROXY_ERROR descritivo, sem credenciais", async () => {
    denyStatus = 407;
    const err = await fetchPage("http://alvo.test/", {
      ...base,
      env: { HTTP_PROXY: `http://admin:hunter2@${denyUrl}` },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const e = err as Web2mdError;
    expect(e).toBeInstanceOf(Web2mdError);
    expect(e.code).toBe("PROXY_ERROR");
    expect(e.message).toContain("407");
    expect(e.message).toContain("autenticação");
    expect(e.message).toContain(denyUrl);
    expect(e.message).not.toContain("hunter2");
    expect(e.message).not.toContain("admin");
  });

  it("407 no CONNECT (alvo https) vira PROXY_ERROR descritivo", async () => {
    denyStatus = 407;
    connects.length = 0;
    const err = await fetchPage("https://alvo.test/", {
      ...base,
      env: { HTTPS_PROXY: `http://admin:hunter2@${denyUrl}` },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const e = err as Web2mdError;
    expect(e).toBeInstanceOf(Web2mdError);
    expect(e.code).toBe("PROXY_ERROR");
    expect(e.message).toContain("407");
    expect(e.message).not.toContain("hunter2");
    expect(connects).toEqual(["alvo.test:443"]);
  });

  it("403 no CONNECT vira PROXY_ERROR ('recusou') e não é repetido", async () => {
    denyStatus = 403;
    connects.length = 0;
    const err = await fetchPage("https://alvo.test/", {
      ...base,
      env: { HTTPS_PROXY: `http://${denyUrl}` },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const e = err as Web2mdError;
    expect(e.code).toBe("PROXY_ERROR");
    expect(e.message).toContain("recusou");
    expect(e.message).toContain("403");
    expect(connects).toHaveLength(1);
  });

  it("configuração de proxy inválida falha com PROXY_ERROR", async () => {
    const err = await fetchPage("https://example.com/", { ...base, env: { HTTPS_PROXY: "ftp://x:y@proxy:21" } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Web2mdError).code).toBe("PROXY_ERROR");
    expect((err as Web2mdError).message).not.toContain("x:y");
  });
});
