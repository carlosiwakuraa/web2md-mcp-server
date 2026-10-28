import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Web2mdError } from "../src/errors.js";
import { fetchPage } from "../src/stages/fetch.js";

let server: http.Server;
let base: string;
const hits: string[] = [];

const HTML = "<!doctype html><html><head><title>t</title></head><body><p>destino ok</p></body></html>";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    hits.push(path + url.search);
    const redirect = (status: number, location?: string) => {
      res.writeHead(status, location === undefined ? {} : { location });
      res.end();
    };
    if (path === "/final") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(HTML);
    }
    if (path === "/rel") return redirect(302, "/final");
    if (path === "/rel-dotdot") return redirect(301, "../final");
    if (path === "/abs") return redirect(307, `${base}/final`);
    if (path === "/hop1") return redirect(302, "/hop2");
    if (path === "/hop2") return redirect(302, "/hop3");
    if (path === "/hop3") return redirect(302, "/final");
    if (path === "/loop") return redirect(302, "/loop");
    if (path === "/no-location") return redirect(302);
    if (path === "/bad-location") return redirect(302, "http://[::1");
    if (path === "/to-file") return redirect(302, "file:///etc/passwd");
    if (path === "/with-fragment") return redirect(302, "/final#secao");
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function html(path: string) {
  const r = await fetchPage(`${base}${path}`, { timeoutMs: 5000 });
  if (r.kind !== "html") throw new Error("esperava HTML");
  return r;
}

describe("redirects seguidos manualmente (comportamento real)", () => {
  it("segue redirect relativo, com ../ e absoluto, e devolve a URL final", async () => {
    for (const path of ["/rel", "/rel-dotdot", "/abs", "/with-fragment"]) {
      const r = await html(path);
      expect(r.html).toContain("destino ok");
      expect(new URL(r.finalUrl).pathname).toBe("/final");
    }
  });

  it("segue cadeias de vários saltos", async () => {
    const r = await html("/hop1");
    expect(r.html).toContain("destino ok");
    expect(hits).toContain("/hop2");
    expect(hits).toContain("/hop3");
  });

  it("loop de redirects falha com erro descritivo e não trava", async () => {
    await expect(fetchPage(`${base}/loop`, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: expect.stringMatching(/redirecion/i),
    });
  });

  it("redirect sem Location, com destino inválido ou para esquema não suportado vira erro, sem seguir", async () => {
    for (const path of ["/no-location", "/bad-location", "/to-file"]) {
      const err = await fetchPage(`${base}${path}`, { timeoutMs: 5000 }).catch((e) => e);
      expect(err).toBeInstanceOf(Web2mdError);
    }
  });

  it("não vaza user:pass@ nas mensagens de erro (URL com credenciais é recusada)", async () => {
    const err = (await fetchPage(`http://user:s3cr3t@127.0.0.1:${new URL(base).port}/final`, {
      timeoutMs: 5000,
    }).catch((e) => e)) as Error;
    // Com ou sem credenciais aceitas pelo fetch, a senha nunca pode aparecer.
    if (err instanceof Error) expect(err.message).not.toContain("s3cr3t");
  });

  it("não vaza token de query nas mensagens de erro", async () => {
    const err = (await fetchPage(`${base}/inexistente?token=SEGREDO123&q=1`, { timeoutMs: 5000 }).catch(
      (e) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Web2mdError);
    expect(err.message).not.toContain("SEGREDO123");
  });
});
