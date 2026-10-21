import { describe, expect, it } from "vitest";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import type { ConvertContext } from "../src/types.js";
import { registerTableRules } from "../src/rules/tables.js";
import { registerEmbeddedRules } from "../src/rules/embedded.js";
import { registerMathRules } from "../src/rules/math.js";
import { registerAdmonitionRules } from "../src/rules/admonitions.js";

const BASE = "https://example.com/docs/page";
const ctx: ConvertContext = {
  baseUrl: BASE,
  resolveUrl(raw) {
    try {
      return new URL(raw, BASE).href;
    } catch {
      return raw;
    }
  },
};

/** Mesma ordem de registro do convert.ts, sem as regras dos outros agentes (usa o padrão do Turndown). */
function makeTd(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  registerTableRules(td, ctx);
  registerEmbeddedRules(td, ctx);
  registerMathRules(td, ctx);
  registerAdmonitionRules(td, ctx);
  return td;
}

const md = (html: string): string => makeTd().turndown(html);

describe("tables", () => {
  it("converte tabela simples com thead em GFM", () => {
    const out = md(
      "<table><thead><tr><th>Nome</th><th>Idade</th></tr></thead><tbody><tr><td>Ana</td><td>30</td></tr><tr><td>Beto</td><td>25</td></tr></tbody></table>",
    );
    expect(out).toBe("| Nome | Idade |\n| --- | --- |\n| Ana | 30 |\n| Beto | 25 |");
  });

  it("usa a primeira linha como cabeçalho quando não há thead", () => {
    const out = md("<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>");
    expect(out).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("escapa | nas células e mantém pipes já escapados", () => {
    const out = md("<table><tr><th>expr</th><th>desc</th></tr><tr><td>a | b</td><td><code>x|y</code></td></tr></table>");
    expect(out).toContain("| a \\| b | `x\\|y` |");
    expect(out.split("\n")).toHaveLength(3);
  });

  it("preenche linhas irregulares e células vazias", () => {
    const out = md("<table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td>1</td></tr><tr><td></td><td>2</td></tr></table>");
    expect(out).toBe("| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |\n|  | 2 |  |");
  });

  it("aplica alinhamento por align e text-align", () => {
    const out = md(
      '<table><tr><th align="left">a</th><th style="text-align: center">b</th><th align="right">c</th><th>d</th></tr><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></table>',
    );
    expect(out.split("\n")[1]).toBe("| :--- | :---: | ---: | --- |");
  });

  it("converte <br> em célula para <br> literal e unwrap de <p> único", () => {
    const out = md("<table><tr><th>a</th><th>b</th></tr><tr><td>linha1<br>linha2</td><td><p>solo</p></td></tr></table>");
    expect(out).toContain("| linha1<br>linha2 | solo |");
  });

  it("mantém inline (negrito, link) dentro da célula", () => {
    const out = md('<table><tr><th>a</th></tr><tr><td><strong>x</strong> <a href="/p">y</a></td></tr></table>');
    expect(out).toContain("| **x** [y](/p) |");
  });

  it("caption vira parágrafo em negrito antes da tabela", () => {
    const out = md("<table><caption>Vendas</caption><tr><th>a</th></tr><tr><td>1</td></tr></table>");
    expect(out).toBe("**Vendas**\n\n| a |\n| --- |\n| 1 |");
  });

  it("colspan cai para HTML embutido limpo", () => {
    const out = md(
      '<p>antes</p><table class="x" style="color:red"><thead><tr><th colspan="2" class="c">Grupo</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table><p>depois</p>',
    );
    expect(out).toBe(
      [
        "antes",
        "",
        "<table>",
        "  <thead>",
        "    <tr>",
        '      <th colspan="2">Grupo</th>',
        "    </tr>",
        "  </thead>",
        "  <tbody>",
        "    <tr>",
        "      <td>a</td>",
        "      <td>b</td>",
        "    </tr>",
        "  </tbody>",
        "</table>",
        "",
        "depois",
      ].join("\n"),
    );
  });

  it("rowspan também usa HTML", () => {
    const out = md('<table><tr><th>a</th><th>b</th></tr><tr><td rowspan="2">x</td><td>1</td></tr><tr><td>2</td></tr></table>');
    expect(out).toContain('<td rowspan="2">x</td>');
    expect(out).not.toContain("| ---");
  });

  it("bloco (lista) dentro de célula cai para HTML, com inline convertido para HTML", () => {
    const out = md(
      '<table><tr><th>a</th><th>b</th></tr><tr><td><ul><li>um</li><li><b>dois</b></li></ul></td><td>ok <a href="/x" class="k">link</a></td></tr></table>',
    );
    expect(out).toContain("<td><ul><li>um</li><li><strong>dois</strong></li></ul></td>");
    expect(out).toContain('<td>ok <a href="https://example.com/x">link</a></td>');
    expect(out).not.toContain("class=");
  });

  it("dois parágrafos na célula -> HTML; <pre> preserva quebras sem linhas em branco", () => {
    const out = md("<table><tr><th>a</th></tr><tr><td><pre>l1\n\nl3</pre></td></tr></table>");
    expect(out).toContain("<pre><code>l1\n&#10;l3</code></pre>");
    expect(out).not.toMatch(/\n\n(?=\s*<\/?t)/);
  });

  it("tabela aninhada (layout) vai como HTML embutido", () => {
    const out = md(
      "<table><tr><td>menu</td><td><table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table></td></tr></table>",
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<td><table><tbody><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></tbody></table></td>");
  });

  it("tabela de uma única célula (layout) devolve o conteúdo", () => {
    const out = md("<table><tr><td><p>um</p><p>dois</p></td></tr></table>");
    expect(out).toBe("um\n\ndois");
  });

  it("funciona com elementos DOM do jsdom (não só strings)", () => {
    const dom = new JSDOM("<body><table><tr><th>a</th></tr><tr><td>1 | 2</td></tr></table></body>");
    const out = makeTd().turndown(dom.window.document.body);
    expect(out).toBe("| a |\n| --- |\n| 1 \\| 2 |");
  });
});

describe("details/summary, sup/sub/kbd/mark", () => {
  it("details com summary vira HTML com Markdown interno", () => {
    const out = md("<details><summary>Ver mais</summary><p>Texto <strong>forte</strong></p><ul><li>a</li></ul></details>");
    expect(out).toMatch(/^<details>\n<summary>Ver mais<\/summary>\n\nTexto \*\*forte\*\*\n\n- +a\n\n<\/details>$/);
  });

  it("preserva o atributo open e cria summary padrão", () => {
    const out = md("<p>x</p><details open><p>corpo</p></details>");
    expect(out).toBe("x\n\n<details open>\n<summary>Details</summary>\n\ncorpo\n\n</details>");
  });

  it("details vazio some; summary com código/inline fica numa linha", () => {
    expect(md("<p>a</p><details></details><p>b</p>")).toBe("a\n\nb");
    const out = md("<details><summary>Usar <code>foo()</code></summary>x</details>");
    expect(out).toContain("<summary>Usar `foo()`</summary>");
  });

  it("details funciona com DOM do jsdom e junto de aviso", () => {
    const dom = new JSDOM('<body><details open><summary>q</summary>z</details><div class="admonition tip"><p class="admonition-title">Tip</p><p>jsd</p></div></body>');
    expect(makeTd().turndown(dom.window.document.body)).toBe("<details open>\n<summary>q</summary>\n\nz\n\n</details>\n\n> [!TIP]\n> jsd");
  });

  it("sup, sub, kbd e mark viram HTML com conteúdo inline convertido", () => {
    const out = md("<p>E=mc<sup>2</sup>, H<sub>2</sub>O, <kbd>Ctrl</kbd>+<kbd>C</kbd>, <mark><strong>chave</strong></mark></p>");
    expect(out).toBe("E=mc<sup>2</sup>, H<sub>2</sub>O, <kbd>Ctrl</kbd>+<kbd>C</kbd>, <mark>**chave**</mark>");
  });

  it("sup com link (nota de rodapé) e sup vazio", () => {
    const out = md('<p>fato<sup><a href="#fn1">1</a></sup>ok<sup></sup></p>');
    expect(out).toBe("fato<sup>[1](#fn1)</sup>ok");
  });

  it("kbd aninhado", () => {
    expect(md("<p><kbd><kbd>Ctrl</kbd>+<kbd>C</kbd></kbd></p>")).toBe("<kbd><kbd>Ctrl</kbd>+<kbd>C</kbd></kbd>");
  });
});

describe("media", () => {
  it("video com src relativo e title", () => {
    expect(md('<video src="/v/a.mp4" title="Demo"></video>')).toBe("[Vídeo: Demo](https://example.com/v/a.mp4)");
  });

  it("video usa o primeiro <source> e ignora texto de fallback como título", () => {
    const out = md('<video controls><source src="a.webm" type="video/webm"><source src="a.mp4">Seu navegador não suporta vídeo.</video>');
    expect(out).toBe("[Vídeo](https://example.com/docs/a.webm)");
  });

  it("audio com aria-label e data-src", () => {
    expect(md('<audio data-src="https://cdn.x/y.mp3" aria-label="Podcast [ep 1]"></audio>')).toBe(
      "[Áudio: Podcast \\[ep 1\\]](https://cdn.x/y.mp3)",
    );
  });

  it("iframe de YouTube é Vídeo; outro iframe é Iframe", () => {
    expect(md('<iframe src="https://www.youtube.com/embed/abc" title="Tutorial"></iframe>')).toBe(
      "[Vídeo: Tutorial](https://www.youtube.com/embed/abc)",
    );
    expect(md('<iframe src="https://maps.example.org/embed?x=(1)"></iframe>')).toBe(
      "[Iframe](https://maps.example.org/embed?x=%281%29)",
    );
  });

  it("sem src: descarta o elemento, mas preserva o texto de fallback", () => {
    expect(md("<p>a</p><video>Seu navegador não suporta vídeo.</video><p>b</p>")).toBe("a\n\nSeu navegador não suporta vídeo.\n\nb");
    expect(md('<p>a</p><iframe src="about:blank"></iframe><p>b</p>')).toBe("a\n\nb");
  });

  it("título pelo <track> e iframe com data-src", () => {
    expect(md('<video src="v.mp4"><track kind="captions" label="Legendas PT"></video>')).toBe(
      "[Vídeo: Legendas PT](https://example.com/docs/v.mp4)",
    );
    expect(md('<iframe data-src="https://player.vimeo.com/video/1" title="V"></iframe>')).toBe(
      "[Vídeo: V](https://player.vimeo.com/video/1)",
    );
  });
});

describe("math", () => {
  const katexInline =
    '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi><mo>=</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">x = \\frac{1}{2}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord mathnormal">x</span><span class="mrel">=</span><span class="mord">1</span><span class="mord">2</span></span></span></span>';

  it("KaTeX inline usa a anotação TeX e ignora .katex-html", () => {
    expect(md(`<p>Seja ${katexInline} verdade.</p>`)).toBe("Seja $x = \\frac{1}{2}$ verdade.");
  });

  it("KaTeX display ($$)", () => {
    const out = md(`<p>antes</p><span class="katex-display">${katexInline}</span><p>depois</p>`);
    expect(out).toBe("antes\n\n$$\nx = \\frac{1}{2}\n$$\n\ndepois");
  });

  it("MathJax v2: script math/tex substitui preview e saída renderizada", () => {
    const html =
      '<p>Valor <span class="MathJax_Preview" style="color:inherit">[math]</span><span class="MathJax" id="MathJax-Element-1-Frame"><nobr><span>a</span><span>2</span></nobr></span><script type="math/tex" id="MathJax-Element-1">a^2 + b_1</script> fim</p>' +
      '<div class="MathJax_Display"><span class="MathJax">E</span></div><script type="math/tex; mode=display">E = mc^2 \\\\ \\sum_{i}</script>';
    expect(md(html)).toBe("Valor $a^2 + b_1$ fim\n\n$$\nE = mc^2 \\\\ \\sum_{i}\n$$");
  });

  it("MathJax v2 sem script: mantém o preview (não perde texto)", () => {
    expect(md('<p>x <span class="MathJax_Preview">a+b</span> y</p>')).toBe("x a+b y");
  });

  it("MathJax v3: mjx-container com anotação, data-latex e display", () => {
    const withAnn =
      '<mjx-container class="MathJax" jax="CHTML"><mjx-math><mjx-mi><mjx-c>x</mjx-c></mjx-mi></mjx-math><mjx-assistive-mml><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_{i}</annotation></semantics></math></mjx-assistive-mml></mjx-container>';
    expect(md(`<p>vale ${withAnn}.</p>`)).toBe("vale $x_{i}$.");
    const latexAttr =
      '<mjx-container class="MathJax" jax="SVG" display="true" data-latex="\\int_0^1 f"><svg><g></g></svg></mjx-container>';
    expect(md(`<p>a</p>${latexAttr}<p>b</p>`)).toBe("a\n\n$$\n\\int_0^1 f\n$$\n\nb");
  });

  it("<math> sem anotação: converte MathML simples para TeX", () => {
    const out = md(
      '<p>Pitágoras: <math><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msqrt><mi>c</mi></msqrt></math></p>',
    );
    expect(out).toBe("Pitágoras: $a^2+b^2=\\sqrt{c}$");
  });

  it("<math display=block> com anotação e Wikipedia {\\displaystyle}", () => {
    const html =
      '<span class="mwe-math-element"><span class="mwe-math-mathml-display"><math display="block"><semantics><mi>E</mi><annotation encoding="application/x-tex">{\\displaystyle E=mc^{2}}</annotation></semantics></math></span><img class="mwe-math-fallback-image-display" alt="{\\displaystyle E=mc^{2}}"></span>';
    expect(md(html)).toBe("$$\nE=mc^{2}\n$$");
  });

  it("não escapa o TeX (underscores, asteriscos, #)", () => {
    const out = md('<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">a_1 * b_2 \\# c</annotation></semantics></math></p>');
    expect(out).toBe("$a_1 * b_2 \\# c$");
  });

  it("mjx-container só com SVG e aria-label não é descartado como 'vazio'", () => {
    expect(md('<p>v <mjx-container jax="SVG" aria-label="x squared"><svg><g></g></svg></mjx-container> w</p>')).toContain("$x squared$");
  });

  it("matemática dentro de célula de tabela GFM fica inline com | escapado", () => {
    const k = '<span class="katex-display"><span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">|x|</annotation></semantics></math></span></span>';
    const out = md(`<table><tr><th>f</th></tr><tr><td>${k}</td></tr></table>`);
    expect(out).toBe("| f |\n| --- |\n| $\\|x\\|$ |");
  });
});

describe("admonitions", () => {
  it("aside.note simples", () => {
    expect(md('<aside class="note"><p>Cuidado com isto.</p></aside>')).toBe("> [!NOTE]\n> Cuidado com isto.");
  });

  it("mapeia a categoria pela classe", () => {
    const cases: [string, string][] = [
      ['<div class="warning"><p>x</p></div>', "WARNING"],
      ['<div class="alert alert-danger"><p>x</p></div>', "CAUTION"],
      ['<div class="tip"><p>x</p></div>', "TIP"],
      ['<div class="hint"><p>x</p></div>', "TIP"],
      ['<div class="important"><p>x</p></div>', "IMPORTANT"],
      ['<div class="callout callout-success"><p>x</p></div>', "TIP"],
      ['<div class="callout"><p>x</p></div>', "NOTE"],
      ['<div role="note"><p>x</p></div>', "NOTE"],
      ['<div class="markdown-alert markdown-alert-caution"><p>x</p></div>', "CAUTION"],
      ['<div class="notecard warning"><p>x</p></div>', "WARNING"],
    ];
    for (const [html, kind] of cases) expect(md(html), html).toBe(`> [!${kind}]\n> x`);
  });

  it("MkDocs/Sphinx: título redundante removido, título customizado mantido em negrito", () => {
    expect(md('<div class="admonition warning"><p class="admonition-title">Warning</p><p>Não faça.</p></div>')).toBe(
      "> [!WARNING]\n> Não faça.",
    );
    expect(md('<div class="admonition tip"><p class="admonition-title">Dica de performance</p><p>Use cache.</p></div>')).toBe(
      "> [!TIP]\n> **Dica de performance**\n>\n> Use cache.",
    );
  });

  it("MDN: <strong>Note:</strong> inicial define a categoria e some", () => {
    expect(md('<div class="notecard note"><p><strong>Note:</strong> Texto da nota.</p></div>')).toBe("> [!NOTE]\n> Texto da nota.");
    expect(md('<div class="callout"><p><strong>Atenção</strong>: confira.</p></div>')).toBe("> [!WARNING]\n> confira.");
  });

  it("categoria pelo título quando a classe não diz nada", () => {
    expect(md('<aside role="note"><strong>Dica:</strong> use atalhos.</aside>')).toBe("> [!TIP]\n> use atalhos.");
    expect(md('<div class="admonition"><div class="admonition-title">Importante</div><p>Leia.</p></div>')).toBe(
      "> [!IMPORTANT]\n> Leia.",
    );
  });

  it("Docusaurus", () => {
    const html =
      '<div class="theme-admonition theme-admonition-tip alert alert--success admonition_xJq3"><div class="admonitionHeading_Gvgb"><span class="admonitionIcon_Rf37"><svg viewBox="0 0 12 16"><path d="M6.5"></path></svg></span>tip</div><div class="admonitionContent_BuS1"><p>Corpo da dica.</p></div></div>';
    expect(md(html)).toBe("> [!TIP]\n> Corpo da dica.");
  });

  it("GitHub renderizado (p.markdown-alert-title com svg)", () => {
    const html =
      '<div class="markdown-alert markdown-alert-important"><p class="markdown-alert-title"><svg class="octicon"><path d="M0"></path></svg>Important</p><p>Leia antes.</p></div>';
    expect(md(html)).toBe("> [!IMPORTANT]\n> Leia antes.");
  });

  it("preserva blocos internos: lista e código; aviso aninhado", () => {
    const html =
      '<div class="admonition warning"><p class="admonition-title">Warning</p><p>Execute:</p><pre><code class="language-sh">rm -rf x\n\nls</code></pre><ul><li>um</li><li>dois</li></ul>' +
      '<div class="admonition tip"><p class="admonition-title">Tip</p><p>interno</p></div></div>';
    const out = md(html);
    expect(out.startsWith("> [!WARNING]\n> Execute:\n>\n")).toBe(true);
    expect(out).toContain("> ```sh\n> rm -rf x\n>\n> ls\n> ```");
    expect(out).toMatch(/> - +um\n> - +dois/);
    expect(out).toContain("> > [!TIP]\n> > interno");
  });

  it("aviso vazio é descartado; aside sem classe não vira aviso", () => {
    expect(md('<p>a</p><div class="admonition note"><p class="admonition-title">Note</p></div><p>b</p>')).toBe("a\n\nb");
    expect(md("<aside><p>lateral</p></aside>")).toBe("lateral");
  });

  it("details.admonition (MkDocs colapsável) usa summary como título", () => {
    const html = '<details class="admonition note"><summary>Detalhes extras</summary><p>conteúdo</p></details>';
    expect(md(html)).toBe("> [!NOTE]\n> **Detalhes extras**\n>\n> conteúdo");
  });

  it("tabela dentro de aviso fica citada", () => {
    const html = '<div class="admonition note"><p class="admonition-title">Note</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></div>';
    expect(md(html)).toBe("> [!NOTE]\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |");
  });

  it("classe solta em contêiner gigante não vira aviso", () => {
    const big = "<p>" + "palavra ".repeat(600) + "</p>";
    const out = md(`<div class="info">${big}</div>`);
    expect(out.startsWith("> [!")).toBe(false);
  });
});

describe("elementos desconhecidos", () => {
  it("mantém o texto dos filhos", () => {
    expect(md("<p>a <foo>texto</foo> b</p>")).toBe("a texto b");
    expect(md("<custom-element>olá <b>mundo</b></custom-element>")).toBe("olá **mundo**");
    expect(md("<section><span>um</span> <span>dois</span></section>")).toBe("um dois");
    expect(md("<x-card><x-title>T</x-title><x-body>corpo</x-body></x-card>")).toBe("Tcorpo");
  });

  it("não perde espaços entre palavras por causa de inline vazio", () => {
    expect(md("<p>foo<span> </span>bar</p>")).toBe("foo bar");
    expect(md("<p>foo <x-empty></x-empty>bar</p>")).toBe("foo bar");
  });

  it("blocos desconhecidos em sequência não colam texto", () => {
    expect(md("<section>a</section><section>b</section>")).toBe("a\n\nb");
  });
});
