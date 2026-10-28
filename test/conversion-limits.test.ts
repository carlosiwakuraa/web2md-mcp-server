import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { errorResult, UNEXPECTED_ERROR_MESSAGE } from "../src/index.js";
import { runPipeline } from "../src/pipeline.js";
import { convertHtml } from "../src/worker/convert-core.js";
import {
  convertHtmlInWorker,
  createConversionPool,
  postProcessInWorker,
  type ConversionPool,
  type HtmlTask,
} from "../src/worker/client.js";
import { prescanHtml, resolveLimits } from "../src/worker/guards.js";
import type { ToolInput } from "../src/types.js";

const wrap = (body: string) => `<html><head><title>T</title></head><body><main><h1>Oi</h1>${body}</main></body></html>`;
const task = (html: string, over: Partial<HtmlTask> = {}): HtmlTask => ({
  html,
  pageUrl: "https://exemplo.com/p",
  mode: "article",
  includeLinks: false,
  wantHeadings: false,
  ...over,
});
const LOREM = "texto de exemplo suficiente para passar da heurística de conteúdo vazio. ".repeat(5);

// Um pool real (worker de verdade) compartilhado: o 1º worker leva ~1 s para subir (tsx + jsdom).
let pool: ConversionPool;
beforeAll(() => {
  pool = createConversionPool({ maxWorkers: 2, taskTimeoutMs: 20_000 });
});
afterAll(() => pool.shutdown());
afterEach(() => {
  delete process.env.WEB2MD_MAX_HTML_BYTES;
});

describe("conversão isolada em worker", { timeout: 30_000 }, () => {
  it("produz o mesmo resultado da conversão síncrona", async () => {
    const html = wrap(`<h2>Seção</h2><p>${LOREM}</p><ul><li>a</li><li>b</li></ul><a href="/x">link</a>`);
    const out = await convertHtmlInWorker(task(html, { includeLinks: true, wantHeadings: true }), { pool });
    const direct = convertHtml(html, "https://exemplo.com/p", { mode: "article", includeLinks: true });
    expect(out.page).toEqual(direct);
    expect(out.body).toBe(direct.body);
    expect(out.headings?.map((h) => h.text)).toEqual(["Oi", "Seção", "Links da página"]);
  });

  it("erros de negócio (conteúdo vazio) atravessam o worker com código e mensagem", async () => {
    await expect(convertHtmlInWorker(task("<html><body></body></html>"), { pool })).rejects.toMatchObject({
      name: "Web2mdError",
      code: "EMPTY_CONTENT",
    });
  });

  it("markdown nativo é pós-processado no worker", async () => {
    const out = await postProcessInWorker("# Título   \n\n\n\n\ntexto\n", true, { pool });
    expect(out.page).toBeNull();
    expect(out.body).toBe("# Título\n\n\ntexto\n");
    expect(out.headings?.[0]?.text).toBe("Título");
  });

  it("HTML acima do teto (WEB2MD_MAX_HTML_BYTES) é rejeitado antes de ir ao worker", async () => {
    process.env.WEB2MD_MAX_HTML_BYTES = "1000";
    const fresh = createConversionPool();
    const err = await convertHtmlInWorker(task(wrap(`<p>${LOREM.repeat(5)}</p>`)), { pool: fresh }).catch((e) => e);
    expect(err).toMatchObject({ code: "CONVERSION_LIMIT" });
    expect(err.message).toContain("WEB2MD_MAX_HTML_BYTES");
    expect(fresh.workerCount).toBe(0); // nem chegou a criar worker
  });

  it("WEB2MD_MAX_HTML_BYTES inválido ou placeholder cai no padrão de 5 MB", () => {
    for (const v of ["abc", "-5", "0", "${user_config.max}", ""]) {
      process.env.WEB2MD_MAX_HTML_BYTES = v;
      expect(resolveLimits().maxHtmlBytes).toBe(5 * 1024 * 1024);
    }
    process.env.WEB2MD_MAX_HTML_BYTES = "2048";
    expect(resolveLimits().maxHtmlBytes).toBe(2048);
  });

  it("aninhamento absurdo (<div> x10000) é barrado pela pré-checagem, em milissegundos", async () => {
    const html = wrap("<div>".repeat(10_000) + LOREM);
    const started = Date.now();
    await expect(convertHtmlInWorker(task(html), { pool })).rejects.toMatchObject({
      code: "CONVERSION_LIMIT",
      message: expect.stringContaining("aninhamento"),
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("elementos demais (<p>a x300000) são barrados pela pré-checagem", async () => {
    const html = wrap("<p>a".repeat(300_000));
    const started = Date.now();
    await expect(convertHtmlInWorker(task(html), { pool })).rejects.toMatchObject({
      code: "CONVERSION_LIMIT",
      message: expect.stringContaining("elementos HTML demais"),
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("profundidade entre o limite e o corte da pré-checagem é barrada pós-parse (no worker)", async () => {
    const html = wrap("<div>".repeat(600) + LOREM + "</div>".repeat(600)); // 600 > 512, < 2048
    prescanHtml(html, { maxNodes: 100_000, maxDepth: 512 }); // a pré-checagem deixa passar
    await expect(convertHtmlInWorker(task(html), { pool })).rejects.toMatchObject({
      code: "CONVERSION_LIMIT",
      message: expect.stringContaining("profundidade 512"),
    });
  });

  it("limites injetáveis: contagem de elementos pós-parse", async () => {
    const html = wrap(`<p>${LOREM}</p>`.repeat(30));
    await expect(
      convertHtmlInWorker(task(html), { pool, limits: { maxNodes: 20 } }),
    ).rejects.toMatchObject({ code: "CONVERSION_LIMIT" });
    // com o limite padrão a mesma página converte
    await expect(convertHtmlInWorker(task(html), { pool })).resolves.toBeDefined();
  });

  it("não há falso positivo: HTML sem </p>, </li>, </td> e com <script> cheio de '<div>'", () => {
    const sloppy = wrap(
      "<p>a".repeat(5000) + "<ul>" + "<li>x".repeat(5000) + "</ul><table>" + "<tr><td>y".repeat(3000) + "</table>" +
        `<script>${"'<div><div>'".repeat(5000)}</script><!-- ${"<div>".repeat(5000)} -->` + LOREM,
    );
    expect(() => prescanHtml(sloppy, { maxNodes: 100_000, maxDepth: 512 })).not.toThrow();
  });

  it("timeout real: o worker é encerrado e o erro é tratável", async () => {
    // 30 ms é menos que o tempo de subida do worker (tsx + jsdom): estoura sempre, sem esperar muito.
    const short = createConversionPool({ taskTimeoutMs: 30 });
    try {
      await expect(convertHtmlInWorker(task(wrap(`<p>${LOREM}</p>`)), { pool: short })).rejects.toMatchObject({
        code: "CONVERSION_TIMEOUT",
        message: expect.stringContaining("A conversão excedeu"),
      });
      expect(short.workerCount).toBe(0);
    } finally {
      await short.shutdown();
    }
  });

  it("OOM real no worker de conversão vira erro tratável", async () => {
    // Com 8 MB de heap o jsdom estoura já no carregamento/parse: o processo de teste segue vivo.
    const tiny = createConversionPool({ resourceLimits: { maxOldGenerationSizeMb: 8 } });
    try {
      const err = await convertHtmlInWorker(task(wrap(`<p>${LOREM}</p>`)), { pool: tiny }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/limite de memória|Falha interna na conversão/);
    } finally {
      await tiny.shutdown();
    }
  });

  it("cancelamento (AbortSignal) interrompe a conversão em andamento", async () => {
    const ac = new AbortController();
    const p = convertHtmlInWorker(task(wrap(`<p>${LOREM}</p>`)), { pool: createConversionPool(), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
  });
});

describe("runPipeline com conversão isolada", { timeout: 30_000 }, () => {
  const input = (over: Partial<ToolInput> = {}): ToolInput => ({
    url: "https://exemplo.com/p",
    mode: "outline",
    max_chars: 50_000,
    start_index: 0,
    include_links: false,
    return_content: true,
    ...over,
  });
  const fetchImpl = (body: string, contentType = "text/html; charset=utf-8") =>
    (async () => new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;

  it("outline e section funcionam ponta a ponta (HTML)", async () => {
    const html = wrap(`<h2>Alfa</h2><p>${LOREM}</p><h2>Beta</h2><p>${LOREM}</p>`);
    const outline = await runPipeline(input(), { fetchImpl: fetchImpl(html) }, { pool });
    expect(outline.headings?.map((h) => h.heading)).toEqual(["Oi", "Alfa", "Beta"]);
    const section = await runPipeline(input({ mode: "article", section: "beta" }), { fetchImpl: fetchImpl(html) }, { pool });
    expect(section.section?.heading).toBe("Beta");
    expect(section.text).toContain("## Beta");
    expect(section.text).not.toContain("## Alfa");
  });

  it("Markdown nativo passa pelo worker", async () => {
    const md = "# Doc\n\n## Um\n\ntexto\n";
    const r = await runPipeline(input(), { fetchImpl: fetchImpl(md, "text/markdown") }, { pool });
    expect(r.source).toBe("native-markdown");
    expect(r.headings?.map((h) => h.heading)).toEqual(["Doc", "Um"]);
  });

  it("HTML gigante vira erro tratável, não derruba o processo", async () => {
    const html = wrap("<p>a".repeat(300_000));
    await expect(runPipeline(input({ mode: "article" }), { fetchImpl: fetchImpl(html) }, { pool })).rejects.toMatchObject({
      code: "CONVERSION_LIMIT",
    });
  });

  it("signal já abortado: não converte", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runPipeline(input(), { fetchImpl: fetchImpl(wrap(`<p>${LOREM}</p>`)) }, { pool, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
  });
});

describe("mensagem de erro inesperado", () => {
  it("é genérica; o detalhe não vai ao modelo", () => {
    const original = console.error;
    console.error = () => {};
    try {
      const result = errorResult(new Error("segredo: /Users/fulano/.ssh/id_rsa"));
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toBe(UNEXPECTED_ERROR_MESSAGE);
      expect(text).not.toContain("segredo");
    } finally {
      console.error = original;
    }
  });
});
