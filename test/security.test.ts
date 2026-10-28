/**
 * Achados da revisão de segurança: ReDoS quadrático (F1/F2), bypass do filtro de
 * `javascript:` (F5), injeção estrutural de Markdown (F6) e citação YAML (F7).
 * Os limites de tempo são generosos (1 s) para não ficarem flaky; as entradas antigas levavam de 4 a 63 s.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { convertHtml } from "../src/pipeline.js";
import { neutralizeTex } from "../src/rules/math.js";
import { collectLinks, ensureSingleH1, firstH1, paginate, postProcess, renderDocument, yamlValue } from "../src/stages/postprocess.js";
import { parseHeadings, plainText, renderOutline } from "../src/stages/outline.js";
import { makeConvertContext } from "../src/pipeline.js";
import { safeImageSrc, safeLinkHref, safeMediaUrl } from "../src/url-safety.js";

const PAGE = "https://example.com/docs/p";
const conv = (html: string, includeLinks = false): string =>
  convertHtml(html, PAGE, { mode: "full", includeLinks }).body;

function underMs<T>(limit: number, fn: () => T): T {
  const t0 = performance.now();
  const value = fn();
  expect(performance.now() - t0).toBeLessThan(limit);
  return value;
}

// ---------------------------------------------------------------------------- F1 / F2

describe("ReDoS: entradas patológicas processam em tempo linear", () => {
  it("postProcess: corrida longa de espaços / \\f / \\v / NBSP no fim da linha", () => {
    for (const ch of [" ", "\f", "\v", "\u00a0", "\t"]) {
      underMs(1000, () => postProcess(`a${ch.repeat(200_000)}b\n`));
    }
    expect(postProcess(`a  \f\v\u00a0\t\nb\n`)).toBe("a\nb\n");
  });

  it("firstH1 e headings ATX com 200k espaços", () => {
    underMs(1000, () => firstH1(`# a${" ".repeat(200_000)}b\n`));
    underMs(1000, () => parseHeadings(`# a${" ".repeat(200_000)}b\n`));
    expect(firstH1("# Título   ##  \n")).toBe("Título");
    expect(firstH1("# Título #não\n")).toBe("Título #não");
    expect(parseHeadings("## A ##\n\ntexto\n")[0]!.text).toBe("A");
  });

  it("paginate com whitespace no meio do documento", () => {
    underMs(1000, () => paginate(`a${" ".repeat(200_000)}b${" ".repeat(10)}c`, 0, 100_000));
  });

  it("plainText: delimitadores sem fechamento", () => {
    underMs(1000, () => plainText("<http:".repeat(40_000)));
    underMs(1000, () => plainText("![a](".repeat(20_000)));
    underMs(1000, () => plainText("<a ".repeat(40_000)));
    underMs(1000, () => plainText("[a](".repeat(40_000)));
    underMs(1000, () => plainText("*".repeat(100_000)));
    underMs(1000, () => plainText(" _a".repeat(100_000)));
    underMs(1000, () => plainText("`".repeat(100_000) + "x"));
    underMs(1000, () => plainText("<x".repeat(100_000)));
    underMs(1000, () => plainText("**a ".repeat(50_000)));
  });

  it("heading <h2> com <http: x40000 (351 KB) na conversão completa", () => {
    const md = underMs(2000, () => conv(`<h2>${"&lt;http:".repeat(40_000)}</h2><p>x</p>`));
    expect(md).toContain("## ");
  });

  it("HTML com \\f x60000, pre com 200k espaços e data-latex com 60000 espaços", () => {
    underMs(1000, () => conv(`<p>a${"\f".repeat(60_000)}b</p>`));
    underMs(1000, () => conv(`<pre>x${" ".repeat(200_000)}y</pre>`));
    underMs(1000, () => conv(`<p><span class="katex" data-latex="a${" ".repeat(60_000)}b">x</span></p>`));
    underMs(1000, () => conv(`<h2 id="${" ".repeat(50_000)}">T</h2>`));
  });

  it("tabelas: contrabarras longas, math display e <br> em célula", () => {
    underMs(1000, () => conv(`<table><tr><td>${"\\".repeat(100_000)}</td><td>b</td></tr></table>`));
    underMs(1000, () => conv(`<table><tr><td>${" ".repeat(100_000)}<br>${"<br>".repeat(300)}</td><td>b</td></tr></table>`));
  });

  it("srcset com vírgulas e <code> com espaços", () => {
    underMs(1000, () => conv(`<img src="a.png" srcset="x${",".repeat(100_000)}y,">`));
    underMs(1000, () => conv(`<p>a <code>${" ".repeat(100_000)}b </code></p>`));
  });

  it("listas grandes não são quadráticas na numeração", () => {
    const html = `<ol>${"<li>a</li>".repeat(5_000)}</ol>`;
    const md = underMs(5000, () => conv(html));
    expect(md).toContain("5000. a");
  });
});

describe("plainText: mesma saída da implementação por regex nos casos normais", () => {
  /** Implementação anterior (quadrática), mantida só como referência de comportamento. */
  function legacy(md: string): string {
    return md
      .replace(/<a\s+[^>]*?\bid="([^"]*)"[^>]*><\/a>/g, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:[^>\s]*)>/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/(`+)([^`]*?)\1/g, "$2")
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(^|[^\\\w])([*_])(.+?)\2(?!\w)/g, "$1$3")
      .replace(/\\([\\`*_{}[\]()#+\-.!|<>~$])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  const samples = [
    "Usando **negrito**, `código` e [link](https://x.y/z)",
    "snake\\_case e \\*literal\\*",
    "Texto *itálico* e _outro_ aqui",
    "![logo](https://x.y/l.png) Título",
    "[**API**](/api) e `a < b` e <https://x.y/z>",
    '<a id="x"></a>Âncora no meio <a id="y"></a>',
    '<a href="/x" id="z"></a>Com href',
    "~~riscado~~ e __forte__",
    "Preço: 5 * 3 = 15 e 2 * 4",
    "**a** e **b** e `x` e `` y z ``",
    "[a [b] c](u) fim",
    "Título com <span>tag</span> e <b>negrito</b>",
    "  espaços   múltiplos  ",
    "100% [ok] (nada) <3",
    "`a` `b` `c`",
    "a_b_c e a*b*c",
    "\\# não heading \\> nem quote",
    "",
  ];
  it.each(samples)("%j", (s) => {
    expect(plainText(s)).toBe(legacy(s));
  });
});

// ---------------------------------------------------------------------------- F5

describe("allowlist de esquemas de URL", () => {
  const evil = [
    "javascript:alert(1)",
    "java&#9;script:alert(1)",
    "java&#10;script:alert(1)",
    "&#1;javascript:alert(1)",
    "&#x01;&#x02;javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  \n\t javascript:alert(1)",
    "&#xA0;javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://x.y/z",
    "blob:https://example.com/uuid",
  ];

  it.each(evil)("collectLinks descarta %j", (href) => {
    const root = new JSDOM(`<div id="r"><a href="${href}">texto</a><a href="/ok">ok</a></div>`).window.document.getElementById("r")!;
    const ctx = makeConvertContext(PAGE);
    expect(collectLinks(root, ctx.resolveUrl)).toEqual([{ text: "ok", href: "https://example.com/ok" }]);
  });

  it.each(evil)("link inline %j fica só com o texto", (href) => {
    expect(conv(`<p><a href="${href}">texto</a></p>`, true)).toBe("texto\n");
  });

  it.each(evil)("link em tabela complexa %j fica só com o texto", (href) => {
    const md = conv(
      `<table><tr><td colspan="2"><a href="${href}">tl</a> <img src="${href}" alt="i"></td></tr><tr><td>1</td><td>2</td></tr></table>`,
    );
    expect(md).toContain('<td colspan="2">tl</td>');
    expect(md).not.toMatch(/javascript|vbscript|data:|file:|ftp:|blob:/i);
  });

  it.each(evil)("imagem, video e iframe com %j são descartados", (href) => {
    expect(conv(`<p><img src="${href}" alt="x"></p><iframe src="${href}" title="t"></iframe><video src="${href}"></video>`)).not.toMatch(
      /javascript|vbscript|data:|file:|ftp:|blob:|\]\(/i,
    );
  });

  it("mantém http, https, mailto, tel, relativos e fragmentos", () => {
    expect(conv(`<p><a href="https://a.b/c">1</a> <a href="http://a.b/">2</a> <a href="mailto:a@b.c">3</a> <a href="tel:+551199">4</a> <a href="rel/x">5</a> <a href="#sec">6</a></p>`)).toBe(
      "[1](https://a.b/c) [2](http://a.b/) [3](mailto:a@b.c) [4](tel:+551199) [5](https://example.com/docs/rel/x) [6](#sec)\n",
    );
    expect(conv(`<img src="data:image/png;base64,iVBORw0" alt="p">`)).toBe("![p](data:image/png;base64,iVBORw0)\n");
  });

  it("funções de checagem", () => {
    expect(safeLinkHref("https://a.b/")).toBe("https://a.b/");
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(safeLinkHref("")).toBeNull();
    expect(safeLinkHref("not a url")).toBeNull();
    expect(safeMediaUrl("mailto:a@b.c")).toBeNull();
    expect(safeMediaUrl("https://a.b/v")).toBe("https://a.b/v");
    expect(safeImageSrc("data:text/html,x")).toBeNull();
    expect(safeImageSrc("data:image/gif;base64,R0")).toBe("data:image/gif;base64,R0");
  });
});

// ---------------------------------------------------------------------------- F6

describe("injeção estrutural de Markdown", () => {
  it("TeX com `$` não fecha o contexto math (inline e display)", () => {
    const inline = conv(`<p><span class="katex" data-latex="x$ [m](javascript:alert(7)) $y">z</span></p>`);
    expect(inline).toBe("$x\\$ [m]{}(javascript:alert(7)) \\$y$\n");
    const display = conv(`<div class="katex-display"><span class="katex" data-latex="a\n\n# INJECTED\n\`\`\`\n$$\nb">z</span></div>`);
    expect(display).toBe("$$\na\n{}# INJECTED\n{}```\n\\$\\$\nb\n$$\n");
    expect(parseHeadings(display)).toEqual([]);
  });

  it("neutralizeTex preserva fórmulas reais", () => {
    const real = [
      String.raw`E = mc^2`,
      String.raw`\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`,
      String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
      String.raw`a < b \quad b > c`,
      String.raw`x<y`,
      String.raw`\text{preço: \$5} \cdot 2`,
      String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`,
      String.raw`[0,1] \cup (2,3]`,
      String.raw`\left[ \frac{a}{b} \right]`,
    ];
    for (const tex of real) expect(neutralizeTex(tex, false)).toBe(tex);
    const aligned = String.raw`\begin{aligned}
  a &= b \\
  c &= d
\end{aligned}`;
    expect(neutralizeTex(aligned, true)).toBe(aligned);
    expect(neutralizeTex("a \\", false)).toBe("a");
    expect(neutralizeTex("a \\\\", false)).toBe("a \\\\");
    expect(neutralizeTex("a<b>c <script>x</script>", false)).toBe("a< b>c < script>x< /script>");
  });

  it("id de heading com quebra de linha não vira linha de heading", () => {
    const md = conv(`<h2 id="x\n# INJECTED\r\n## OUTRO">T</h2><p>texto</p>`);
    expect(md).toBe('<a id="x#INJECTED##OUTRO"></a>\n## T\n\ntexto\n');
    expect(parseHeadings(md).map((h) => h.text)).toEqual(["T"]);
    expect(conv(`<h2 id='a"><script>'>T</h2><p>t</p>`)).toContain('<a id="a&quot;&gt;&lt;script&gt;"></a>');
  });

  it("alt/title em tabela HTML ficam numa linha só", () => {
    const md = conv(`<table><tr><td colspan="2"><img src="/a.png" alt="x\n# INJECTED"></td></tr><tr><td>1</td><td>2</td></tr></table>`);
    expect(parseHeadings(md)).toEqual([]);
    expect(md).toContain('alt="x # INJECTED"');
  });

  it("linhas de <pre> dentro de tabela complexa não viram heading/cerca", () => {
    const md = conv(`<table><tr><td colspan="2"><pre>x\n# comentario\n\`\`\`\ny</pre></td></tr><tr><td>1</td><td>2</td></tr></table>`);
    expect(parseHeadings(md)).toEqual([]);
    expect(md).toContain("&#35; comentario");
  });

  it("título do outline e H1 de fallback são escapados e numa linha só", () => {
    const title = "Foo [x](javascript:alert(1)) <b>\n# INJECTED\n* y";
    const outline = renderOutline([], 10, title);
    expect(outline.split("\n")[0]).toBe("# Outline: Foo \\[x\\](javascript:alert(1)) \\<b> # INJECTED \\* y");
    expect(parseHeadings(outline)).toHaveLength(1);

    const body = ensureSingleH1("texto\n", title);
    expect(body.split("\n")[0]).toBe("# Foo \\[x\\](javascript:alert(1)) \\<b> # INJECTED \\* y");
    expect(parseHeadings(body)).toHaveLength(1);
    expect(ensureSingleH1("texto\n", "Docs | Site #")).toBe("# Docs | Site \\#\n\ntexto\n");
  });
});

// ---------------------------------------------------------------------------- F7

describe("yamlValue", () => {
  const quoted = [
    "2020-01-01",
    "2020-1-1",
    "2001-12-14t21:59:43.10-05:00",
    "2001-12-14 21:59:43.10 -5",
    "1:30",
    "190:20:30.15",
    "12",
    "-12",
    "+12",
    "1_000",
    "1,000",
    "0o17",
    "017",
    "0x1f",
    "0X1F",
    "0b1",
    "3.14",
    ".5",
    "1e3",
    "-1.5E-3",
    ".inf",
    "-.Inf",
    "+.INF",
    ".nan",
    ".NaN",
    "=",
    "<<",
    "true",
    "No",
    "NULL",
    "~",
    "",
    "a\x7fb",
    "a\u0080b",
    "a\u0085b",
    "a\u009fb",
    "a\ud800b",
    "a\udc00b",
    "a\u2028b",
    "a\ufeffb",
    "tab\there",
    "linha\nquebrada",
  ];
  it.each(quoted)("cita %j e o JSON/YAML volta ao mesmo valor", (v) => {
    const out = yamlValue(v);
    expect(out.startsWith('"') && out.endsWith('"')).toBe(true);
    expect(JSON.parse(out)).toBe(v);
    // nenhum caractere que o YAML 1.2 não considera imprimível sobra literal dentro das aspas
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u007f-\u009f\u2028\u2029\ufeff]/);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it.each(["Guia de uso", "Docs | Site", "v1.2.3", "e5", "pt-BR", "https://ex.com/a?b=c#d", "Nota de 2020-01-01 a 2021", "ok 😀", "12 macacos", "a.b"])(
    "mantém %j sem aspas",
    (v) => {
      expect(yamlValue(v)).toBe(v);
    },
  );

  it("fetched_at gerado (ISO local) continua sem aspas; outros campos com data são citados", () => {
    const out = renderDocument(
      { url: "https://ex.com/", title: "2020-01-01", description: "1:30", fetched_at: "2026-10-20T22:32:00-03:00", source: "html" },
      "x\n",
    );
    expect(out).toContain("fetched_at: 2026-10-20T22:32:00-03:00\n");
    expect(out).toContain('title: "2020-01-01"\n');
    expect(out).toContain('description: "1:30"\n');
  });

  it("não é quadrático em títulos patológicos", () => {
    underMs(1000, () => yamlValue("1".repeat(200_000) + "x"));
    underMs(1000, () => yamlValue("1".repeat(200_000)));
    underMs(1000, () => yamlValue(`${"1_".repeat(100_000)}x`));
    underMs(1000, () => yamlValue(" ".repeat(200_000) + "x"));
    underMs(1000, () => yamlValue(`2020-01-01${" ".repeat(200_000)}x`));
  });
});
