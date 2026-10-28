import http from "node:http";
import type { AddressInfo } from "node:net";
import iconv from "iconv-lite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCEPT_HEADER, MAX_BODY_BYTES, USER_AGENT } from "../src/constants.js";
import { Web2mdError } from "../src/errors.js";
import { fetchPage } from "../src/stages/fetch.js";

let server: http.Server;
let base: string;
let lastHeaders: http.IncomingHttpHeaders = {};

const RU = "Привет, мир! Это тестовая страница на русском языке с достаточно длинным текстом для определения кодировки.";
const JA =
  "これは日本語のテストページです。文字コードを自動的に判定できるかどうかを確認するために、十分に長い文章を書いています。";

function page(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}<title>t</title></head><body><p>${body}</p></body></html>`;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const send = (status: number, type: string | null, body: Buffer | string) => {
      res.writeHead(status, type ? { "content-type": type } : {});
      res.end(body);
    };
    switch (path) {
      case "/md":
        return send(200, "text/markdown; charset=utf-8", "# Olá\n\nconteúdo nativo\n");
      case "/html":
        return send(200, "text/html; charset=utf-8", page("Olá, ação"));
      case "/xhtml":
        return send(200, "application/xhtml+xml", page("xhtml ok"));
      case "/latin1-header":
        return send(200, "text/html; charset=iso-8859-1", iconv.encode(page("Ação, coração, é"), "latin1"));
      case "/meta-charset":
        return send(
          200,
          "text/html",
          iconv.encode(page("Ação, coração, é", '<meta charset="iso-8859-1">'), "latin1"),
        );
      case "/meta-http-equiv":
        return send(
          200,
          "text/html",
          iconv.encode(
            page(
              "Ação, coração, é",
              '<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">',
            ),
            "latin1",
          ),
        );
      case "/chardet-cp1251":
        return send(200, "text/html", iconv.encode(page(RU.repeat(3)), "windows-1251"));
      case "/chardet-sjis":
        return send(200, "text/html", iconv.encode(page(JA.repeat(3)), "shift_jis"));
      case "/bom-utf8":
        return send(200, "text/html", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(page("Olá"))]));
      case "/bom-utf16":
        return send(
          200,
          "text/html",
          Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(page("Olá ação"), "utf-16le")]),
        );
      case "/no-ct-html":
        return send(200, null, "\n<!DOCTYPE HTML><html><body>sniffed</body></html>");
      case "/no-ct-bin":
        return send(200, null, Buffer.from([1, 2, 3, 4]));
      case "/redirect":
        res.writeHead(302, { location: "/html" });
        return res.end();
      case "/404":
        return send(404, "text/html", "nope");
      case "/500":
        return send(500, "text/html", "boom");
      case "/slow":
        return; // nunca responde
      case "/pdf":
        return send(200, "application/pdf", "%PDF-1.4");
      case "/json":
        return send(200, "application/json", "{}");
      default:
        return send(404, "text/plain", "?");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function expectCode(p: Promise<unknown>, code: string): Promise<Web2mdError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Web2mdError);
  expect((err as Web2mdError).code).toBe(code);
  return err as Web2mdError;
}

function htmlOf(r: Awaited<ReturnType<typeof fetchPage>>): string {
  expect(r.kind).toBe("html");
  return r.kind === "html" ? r.html : "";
}

describe("fetchPage: tipos de conteúdo", () => {
  it("retorna markdown nativo direto e envia os headers corretos", async () => {
    const r = await fetchPage(`${base}/md`);
    expect(r).toEqual({ kind: "native-markdown", finalUrl: `${base}/md`, markdown: "# Olá\n\nconteúdo nativo\n" });
    expect(lastHeaders.accept).toBe(ACCEPT_HEADER);
    expect(lastHeaders["user-agent"]).toBe(USER_AGENT);
  });

  it("decodifica HTML utf-8", async () => {
    expect(htmlOf(await fetchPage(`${base}/html`))).toContain("Olá, ação");
  });

  it("aceita application/xhtml+xml", async () => {
    expect(htmlOf(await fetchPage(`${base}/xhtml`))).toContain("xhtml ok");
  });

  it("sniff de HTML sem content-type", async () => {
    expect(htmlOf(await fetchPage(`${base}/no-ct-html`))).toContain("sniffed");
  });

  it("erro para corpo binário sem content-type", async () => {
    await expectCode(fetchPage(`${base}/no-ct-bin`), "UNSUPPORTED_CONTENT_TYPE");
  });

  it("erro para pdf e json", async () => {
    const e = await expectCode(fetchPage(`${base}/pdf`), "UNSUPPORTED_CONTENT_TYPE");
    expect(e.message).toContain("application/pdf");
    await expectCode(fetchPage(`${base}/json`), "UNSUPPORTED_CONTENT_TYPE");
  });
});

describe("fetchPage: encoding", () => {
  it("charset do header (iso-8859-1)", async () => {
    expect(htmlOf(await fetchPage(`${base}/latin1-header`))).toContain("Ação, coração, é");
  });

  it("<meta charset>", async () => {
    expect(htmlOf(await fetchPage(`${base}/meta-charset`))).toContain("Ação, coração, é");
  });

  it("<meta http-equiv=Content-Type>", async () => {
    expect(htmlOf(await fetchPage(`${base}/meta-http-equiv`))).toContain("Ação, coração, é");
  });

  it("chardet: windows-1251", async () => {
    expect(htmlOf(await fetchPage(`${base}/chardet-cp1251`))).toContain(RU);
  });

  it("chardet: shift_jis", async () => {
    expect(htmlOf(await fetchPage(`${base}/chardet-sjis`))).toContain(JA);
  });

  it("respeita BOM utf-8 (e remove o BOM)", async () => {
    const html = htmlOf(await fetchPage(`${base}/bom-utf8`));
    expect(html.startsWith("<!doctype")).toBe(true);
    expect(html).toContain("Olá");
  });

  it("respeita BOM utf-16", async () => {
    expect(htmlOf(await fetchPage(`${base}/bom-utf16`))).toContain("Olá ação");
  });

  it("charset desconhecido cai para utf-8", async () => {
    const fetchImpl = (async () =>
      new Response(page("Olá"), {
        headers: { "content-type": "text/html; charset=x-nao-existe" },
      })) as typeof fetch;
    expect(htmlOf(await fetchPage("https://example.com/", { fetchImpl }))).toContain("Olá");
  });
});

describe("fetchPage: rede e erros", () => {
  it("segue redirects e reporta finalUrl", async () => {
    const r = await fetchPage(`${base}/redirect`);
    expect(r.finalUrl).toBe(`${base}/html`);
    expect(r.kind).toBe("html");
  });

  it("HTTP 404 e 500", async () => {
    const e404 = await expectCode(fetchPage(`${base}/404`), "HTTP_ERROR");
    expect(e404.message).toBe(`Erro HTTP 404 ao acessar ${base}/404`);
    const e500 = await expectCode(fetchPage(`${base}/500`), "HTTP_ERROR");
    expect(e500.message).toContain("500");
  });

  it("timeout", async () => {
    await expectCode(fetchPage(`${base}/slow`, { timeoutMs: 150 }), "TIMEOUT");
  });

  it("timeout durante a leitura do corpo", async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html>"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    await expectCode(fetchPage("https://example.com/", { fetchImpl, timeoutMs: 100 }), "TIMEOUT");
  });

  it("falha de rede (conexão recusada)", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await expectCode(fetchPage(`http://127.0.0.1:${port}/`), "NETWORK_ERROR");
    expect(e.message).toContain("ECONNREFUSED");
  });

  it("usa err.cause.code em erros de rede (ENOTFOUND)", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
    }) as typeof fetch;
    // env vazio: com HTTPS_PROXY no ambiente do runner, a falha seria atribuída ao proxy (PROXY_ERROR).
    const e = await expectCode(fetchPage("https://nao-existe.invalid/", { fetchImpl, env: {} }), "NETWORK_ERROR");
    expect(e.message).toContain("ENOTFOUND");
  });

  it("corpo acima de MAX_BODY_BYTES (content-length)", async () => {
    const fetchImpl = (async () =>
      new Response("x", {
        headers: { "content-type": "text/html", "content-length": String(MAX_BODY_BYTES + 1) },
      })) as typeof fetch;
    const e = await expectCode(fetchPage("https://example.com/", { fetchImpl }), "NETWORK_ERROR");
    expect(e.message).toContain("limite");
  });

  it("corpo acima de MAX_BODY_BYTES (stream sem content-length)", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ > MAX_BODY_BYTES / chunk.length + 2) controller.close();
            else controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "text/html" } },
      )) as typeof fetch;
    await expectCode(fetchPage("https://example.com/", { fetchImpl }), "NETWORK_ERROR");
  });
});

describe("fetchPage: validação de URL", () => {
  it.each(["não é url", "", "/relativa", "ftp://example.com/file", "file:///etc/passwd", "javascript:alert(1)"])(
    "rejeita %j",
    async (raw) => {
      await expectCode(fetchPage(raw), "INVALID_URL");
    },
  );
});

describe("fetchPage: regra developer.apple.com", () => {
  function recorder(handler: (url: string) => Response) {
    const calls: string[] = [];
    const fetchImpl = (async (u: string | URL) => {
      calls.push(String(u));
      return handler(String(u));
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const md = () => new Response("# Doc", { headers: { "content-type": "text/markdown" } });
  const html = () => new Response(page("html"), { headers: { "content-type": "text/html" } });

  it("anexa .md ao path de /documentation/", async () => {
    const { calls, fetchImpl } = recorder(md);
    const r = await fetchPage("https://developer.apple.com/documentation/swiftui/view", { fetchImpl });
    expect(calls).toEqual(["https://developer.apple.com/documentation/swiftui/view.md"]);
    expect(r.kind).toBe("native-markdown");
  });

  it("trata barra final, query e hash", async () => {
    const { calls, fetchImpl } = recorder(md);
    await fetchPage("https://developer.apple.com/documentation/swiftui/?language=objc#topics", { fetchImpl });
    expect(calls).toEqual(["https://developer.apple.com/documentation/swiftui.md?language=objc"]);
  });

  it("fallback para a URL original quando .md dá 404", async () => {
    const { calls, fetchImpl } = recorder((u) =>
      u.endsWith(".md") ? new Response("nf", { status: 404 }) : html(),
    );
    const r = await fetchPage("https://developer.apple.com/documentation/swiftui/view", { fetchImpl });
    expect(calls).toEqual([
      "https://developer.apple.com/documentation/swiftui/view.md",
      "https://developer.apple.com/documentation/swiftui/view",
    ]);
    expect(r.kind).toBe("html");
  });

  it("não faz fallback em erro 5xx (500 não é repetido)", async () => {
    const { calls, fetchImpl } = recorder(() => new Response("x", { status: 500 }));
    await expectCode(fetchPage("https://developer.apple.com/documentation/swiftui/view", { fetchImpl }), "HTTP_ERROR");
    expect(calls).toHaveLength(1);
  });

  it("não reescreve se já termina em .md ou fora de /documentation/", async () => {
    const a = recorder(md);
    await fetchPage("https://developer.apple.com/documentation/swiftui/view.md", { fetchImpl: a.fetchImpl });
    expect(a.calls).toEqual(["https://developer.apple.com/documentation/swiftui/view.md"]);
    const b = recorder(html);
    await fetchPage("https://developer.apple.com/news/", { fetchImpl: b.fetchImpl });
    expect(b.calls).toEqual(["https://developer.apple.com/news/"]);
  });

  it("não afeta outros domínios", async () => {
    const { calls, fetchImpl } = recorder(html);
    await fetchPage("https://example.com/documentation/x", { fetchImpl });
    expect(calls).toEqual(["https://example.com/documentation/x"]);
  });
});
