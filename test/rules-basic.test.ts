import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { registerBlockRules } from "../src/rules/blocks.js";
import { escapeMarkdown, registerInlineRules } from "../src/rules/inline.js";
import type { ConvertContext } from "../src/types.js";

const BASE = "https://example.com/docs/page";

function makeCtx(base = BASE): ConvertContext {
  return {
    baseUrl: base,
    resolveUrl(raw: string) {
      try {
        return new URL(raw, base).href;
      } catch {
        return raw;
      }
    },
  };
}

function conv(html: string, base = BASE): string {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: base });
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  const ctx = makeCtx(base);
  registerBlockRules(td, ctx);
  registerInlineRules(td, ctx);
  return td.turndown(dom.window.document.body);
}

describe("headings", () => {
  it("preserva níveis h1-h6 e não demove h1 extras", () => {
    expect(conv("<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6><h1>G</h1>")).toBe(
      "# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n\n# G",
    );
  });
  it("id vira âncora na linha anterior", () => {
    expect(conv('<p>x</p><h2 id="sec">Título</h2>')).toBe('x\n\n<a id="sec"></a>\n## Título');
  });
  it("a name dentro do heading não duplica e some do texto", () => {
    expect(conv('<h2 id="s"><a name="s"></a>Título</h2>')).toBe('<a id="s"></a>\n## Título');
    expect(conv('<h2><a name="old"></a>Título</h2>')).toBe('<a id="old"></a>\n## Título');
  });
  it("a name vazia imediatamente antes do heading é incorporada", () => {
    expect(conv('<a name="x"></a><h2>T</h2>')).toBe('<a id="x"></a>\n## T');
  });
  it("texto do heading fica em uma linha", () => {
    expect(conv("<h2>Linha um<br>linha dois\n  <div>três</div></h2>")).toBe("## Linha um linha dois três");
  });
  it("remove permalink '#' / '¶' dentro do heading", () => {
    expect(conv('<h2 id="a">Título <a class="anchor" href="#a">¶</a></h2>')).toBe('<a id="a"></a>\n## Título');
  });
  it("mantém link real dentro do heading", () => {
    expect(conv('<h2><a href="#a">Título</a></h2>')).toBe("## [Título](#a)");
  });
  it("heading vazio é descartado", () => {
    expect(conv("<h2> </h2><p>x</p>")).toBe("x");
  });
});

describe("parágrafos e ênfase", () => {
  it("p separa por linha em branco; p vazio é descartado", () => {
    expect(conv("<p>um</p><p></p><p>&nbsp;</p><p>dois</p>")).toBe("um\n\ndois");
  });
  it("strong/b, em/i, del/s/strike", () => {
    expect(conv("<strong>a</strong> <b>b</b> <em>c</em> <i>d</i> <del>e</del> <s>f</s> <strike>g</strike>")).toBe(
      "**a** **b** *c* *d* ~~e~~ ~~f~~ ~~g~~",
    );
  });
  it("move espaços das bordas para fora dos delimitadores", () => {
    expect(conv("<p>a<strong> b </strong>c</p>")).toBe("a **b** c");
    expect(conv("<p>a<em>b </em>c</p>")).toBe("a*b* c");
  });
  it("ênfase vazia é descartada", () => {
    expect(conv("<p>a<strong></strong><em> </em>b</p>")).toBe("a b");
    expect(conv("<p>a<b><i></i></b>b</p>")).toBe("ab");
  });
  it("aninhamento", () => {
    expect(conv("<p><strong>a <em>b</em> c</strong></p>")).toBe("**a *b* c**");
    expect(conv("<p><b><b>x</b></b></p>")).toBe("**x**");
  });
  it("NBSP vira espaço normal fora de code", () => {
    expect(conv("<p>a&nbsp;b</p>")).toBe("a b");
    expect(conv("<p><b>a&nbsp;</b>b</p>")).toBe("**a** b");
  });
  it("elementos desconhecidos mantêm o texto", () => {
    expect(conv("<p>a <foo-bar>texto</foo-bar> <span>b</span></p>")).toBe("a texto b");
  });
  it("whitespace do HTML é colapsado", () => {
    expect(conv("<p>a\n   b\t\tc</p>")).toBe("a b c");
  });
});

describe("code inline", () => {
  it("simples", () => {
    expect(conv("<p>use <code>npm i</code></p>")).toBe("use `npm i`");
  });
  it("crase interna usa delimitador duplo", () => {
    expect(conv("<code>a`b</code>")).toBe("`` a`b ``");
  });
  it("crase nas bordas ganha espaços de guarda", () => {
    expect(conv("<code>`a</code>")).toBe("`` `a ``");
    expect(conv("<code>a`</code>")).toBe("`` a` ``");
    expect(conv("<code>`</code>")).toBe("`` ` ``");
  });
  it("sequência dupla pede delimitador triplo", () => {
    expect(conv("<code>a``b `c</code>")).toBe("``` a``b `c ```");
  });
  it("não escapa nem interpreta markdown dentro de code", () => {
    expect(conv("<code>*a* _b_ [c] | #</code>")).toBe("`*a* _b_ [c] | #`");
    expect(conv("<code><b>x</b> *y*</code>")).toBe("`x *y*`");
  });
  it("code vazio é descartado", () => {
    expect(conv("<p>a<code></code>b</p>")).toBe("ab");
  });
  it("preserva NBSP intencional dentro de code", () => {
    expect(conv("<code>a&nbsp;&nbsp;b</code>")).toBe("`a\u00a0\u00a0b`");
  });
});

describe("pre", () => {
  it("pre > code com linguagem language-x", () => {
    expect(conv('<pre><code class="language-ts">const a = 1;\n  b();\n</code></pre>')).toBe(
      "```ts\nconst a = 1;\n  b();\n```",
    );
  });
  it("lang-x, data-lang, data-language", () => {
    expect(conv('<pre><code class="lang-py">x</code></pre>')).toBe("```py\nx\n```");
    expect(conv('<pre data-lang="rust"><code>x</code></pre>')).toBe("```rust\nx\n```");
    expect(conv('<pre><code data-language="go">x</code></pre>')).toBe("```go\nx\n```");
  });
  it("linguagem no pre ou no wrapper", () => {
    expect(conv('<pre class="language-sh">x</pre>')).toBe("```sh\nx\n```");
    expect(conv('<div class="highlight highlight-source-js"><pre>x</pre></div>')).toBe("```js\nx\n```");
    expect(conv('<div class="language-bash"><pre><code>x</code></pre></div>')).toBe("```bash\nx\n```");
  });
  it("pre puro sem linguagem", () => {
    expect(conv("<pre>linha 1\n    linha 2\n\n\tlinha 4</pre>")).toBe("```\nlinha 1\n    linha 2\n\n\tlinha 4\n```");
  });
  it("cerca maior que qualquer sequência de crases", () => {
    expect(conv("<pre><code>a\n```js\nb\n```\n</code></pre>")).toBe("````\na\n```js\nb\n```\n````");
    expect(conv("<pre><code>x ````` y</code></pre>")).toBe("``````\nx ````` y\n``````");
  });
  it("não escapa markdown nem colapsa espaços dentro de pre", () => {
    expect(conv("<pre>*a*   _b_ # [x]\n  - c</pre>")).toBe("```\n*a*   _b_ # [x]\n  - c\n```");
  });
  it("br dentro de pre vira \\n e spans são achatados", () => {
    expect(conv('<pre><code><span class="k">if</span> (x)<br>  <span class="n">y</span></code></pre>')).toBe(
      "```\nif (x)\n  y\n```",
    );
  });
  it("linhas em spans .line sem \\n entre elas", () => {
    expect(
      conv('<pre><code><span class="line">a</span><span class="line">b</span><span class="line">c</span></code></pre>'),
    ).toBe("```\na\nb\nc\n```");
    expect(conv('<pre><code><span class="line">a</span>\n<span class="line">b</span></code></pre>')).toBe("```\na\nb\n```");
  });
  it("ignora números de linha e coluna linenos", () => {
    expect(conv('<pre><code><span class="line-number">1</span>a\n<span class="line-number">2</span>b</code></pre>')).toBe(
      "```\na\nb\n```",
    );
    expect(
      conv('<table class="highlighttable"><tr><td class="linenos"><div class="linenodiv"><pre>1\n2</pre></div></td><td class="code"><div><pre>a\nb</pre></div></td></tr></table>'),
    ).toContain("```\na\nb\n```");
  });
  it("remove \\n final extra e pre vazio some", () => {
    expect(conv("<pre><code>x\n\n\n</code></pre>")).toBe("```\nx\n```");
    expect(conv("<pre><code>  </code></pre><p>a</p>")).toBe("a");
  });
  it("preserva NBSP em pre", () => {
    expect(conv("<pre>a&nbsp;b</pre>")).toBe("```\na\u00a0b\n```");
  });
});

describe("links", () => {
  it("link com resolução de URL e title", () => {
    expect(conv('<a href="/x/y" title="Um &quot;título&quot;">texto</a>')).toBe('[texto](https://example.com/x/y "Um \\"título\\"")');
    expect(conv('<a href="rel">t</a>')).toBe("[t](https://example.com/docs/rel)");
  });
  it("fragmento não é resolvido", () => {
    expect(conv('<a href="#sec">ir</a>')).toBe("[ir](#sec)");
  });
  it("âncora sem texto é descartada", () => {
    expect(conv('<p>a<a href="/x"></a><a id="y"></a><a name="z"></a>b</p>')).toBe("ab");
    expect(conv('<p>a <a name="z"> </a>b</p>')).toBe("a b");
  });
  it("âncora com img é mantida", () => {
    expect(conv('<a href="/x"><img src="/i.png" alt="logo"></a>')).toBe("[![logo](https://example.com/i.png)](https://example.com/x)");
  });
  it("texto igual à URL vira <url>", () => {
    expect(conv('<a href="https://a.com/x">https://a.com/x</a>')).toBe("<https://a.com/x>");
    expect(conv('<a href="mailto:a@b.com">a@b.com</a>')).toBe("<a@b.com>");
  });
  it("texto relativo igual ao href permanece link", () => {
    expect(conv('<a href="/foo">/foo</a>')).toBe("[/foo](https://example.com/foo)");
  });
  it("javascript: e href vazio ficam só com o texto", () => {
    expect(conv('<a href="javascript:void(0)">clique</a>')).toBe("clique");
    expect(conv('<a href=" JavaScript:alert(1)">x</a>')).toBe("x");
    expect(conv('<a href="">texto</a> <a>outro</a>')).toBe("texto outro");
  });
  it("parênteses e espaços no destino", () => {
    expect(conv('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a>')).toBe("[w](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(conv('<a href="/a)b">w</a>')).toBe("[w](https://example.com/a\\)b)");
    expect(conv('<a href="#a b">w</a>')).toBe("[w](#a%20b)");
  });
  it("texto do link com formatação e colchetes", () => {
    expect(conv('<a href="/x"><b>neg</b> [1]</a>')).toBe("[**neg** \\[1\\]](https://example.com/x)");
  });
  it("espaços nas bordas ficam fora do link", () => {
    expect(conv('<p>a<a href="/x"> t </a>b</p>')).toBe("a [t](https://example.com/x) b");
  });
});

describe("imagens", () => {
  it("src, alt e title", () => {
    expect(conv('<img src="/a.png" alt="Alt" title="T">')).toBe('![Alt](https://example.com/a.png "T")');
  });
  it("sem alt", () => {
    expect(conv('<img src="a.png">')).toBe("![](https://example.com/docs/a.png)");
  });
  it("srcset de maior resolução quando src vazio (w)", () => {
    expect(conv('<img alt="x" srcset="/s.png 320w, /m.png 800w, /l.png 1600w">')).toBe("![x](https://example.com/l.png)");
  });
  it("srcset com x e URLs com vírgula", () => {
    expect(
      conv('<img alt="x" srcset="https://cdn.com/w_300,h_200/a.jpg 1x, https://cdn.com/w_600,h_400/a.jpg 2x">'),
    ).toBe("![x](https://cdn.com/w_600,h_400/a.jpg)");
  });
  it("srcset sem descritor", () => {
    expect(conv('<img srcset="/only.png">')).toBe("![](https://example.com/only.png)");
  });
  it("data-src como segundo fallback", () => {
    expect(conv('<img alt="x" data-src="/lazy.png">')).toBe("![x](https://example.com/lazy.png)");
    expect(conv('<img alt="x" src="data:image/gif;base64,R0lGOD" data-src="/lazy.png">')).toBe("![x](https://example.com/lazy.png)");
  });
  it("sem fonte é descartada", () => {
    expect(conv('<p>a<img alt="x">b</p>')).toBe("ab");
  });
  it("alt escapado", () => {
    expect(conv('<img src="/a.png" alt="a [b] c">')).toBe("![a \\[b\\] c](https://example.com/a.png)");
  });
});

describe("listas", () => {
  it("ul simples com -", () => {
    expect(conv("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
  it("ol com numeração incremental e start", () => {
    expect(conv("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
    expect(conv('<ol start="5"><li>a</li><li>b</li><li>c</li></ol>')).toBe("5. a\n6. b\n7. c");
  });
  it("aninhamento ul > ul com 2 espaços", () => {
    expect(conv("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>")).toBe("- a\n  - b\n    - c\n- d");
  });
  it("aninhamento ol > ol com 3 espaços", () => {
    expect(conv("<ol><li>a<ol><li>b</li></ol></li><li>c</li></ol>")).toBe("1. a\n   1. b\n2. c");
  });
  it("misto ol > ul e ul > ol", () => {
    expect(conv("<ol><li>a<ul><li>x</li><li>y</li></ul></li><li>b</li></ol>")).toBe("1. a\n   - x\n   - y\n2. b");
    expect(conv("<ul><li>a<ol><li>x</li><li>y</li></ol></li></ul>")).toBe("- a\n  1. x\n  2. y");
  });
  it("itens com número de 2 dígitos alinham o recuo", () => {
    expect(conv('<ol start="9"><li>a</li><li>b<ul><li>x</li></ul></li></ol>')).toBe("9. a\n10. b\n    - x");
  });
  it("task list", () => {
    expect(
      conv('<ul><li><input type="checkbox"> a</li><li><input type="checkbox" checked disabled> b</li><li>c</li></ul>'),
    ).toBe("- [ ] a\n- [x] b\n- c");
    expect(conv('<ul><li><label><input type="checkbox" checked> L</label></li></ul>')).toBe("- [x] L");
    expect(conv('<ol><li><input type="checkbox"> a</li></ol>')).toBe("1. [ ] a");
  });
  it("task list aninhada", () => {
    expect(
      conv('<ul><li><input type="checkbox" checked> a<ul><li><input type="checkbox"> b</li></ul></li></ul>'),
    ).toBe("- [x] a\n  - [ ] b");
  });
  it("lista solta preserva parágrafos e recuo", () => {
    expect(conv("<ul><li><p>um</p><p>dois</p></li><li><p>três</p></li></ul>")).toBe("- um\n\n  dois\n\n- três");
  });
  it("código dentro de li", () => {
    expect(conv("<ul><li>a<pre><code>x\n\ny</code></pre></li><li>b</li></ul>")).toBe(
      "- a\n\n  ```\n  x\n\n  y\n  ```\n- b",
    );
  });
  it("li vazio é ignorado e não conta na numeração", () => {
    expect(conv("<ol><li>a</li><li> </li><li>b</li></ol>")).toBe("1. a\n2. b");
  });
  it("lista entre parágrafos", () => {
    expect(conv("<p>antes</p><ul><li>a</li></ul><p>depois</p>")).toBe("antes\n\n- a\n\ndepois");
  });
});

describe("blockquote", () => {
  it("simples e com parágrafos", () => {
    expect(conv("<blockquote><p>a</p><p>b</p></blockquote>")).toBe("> a\n>\n> b");
  });
  it("aninhado", () => {
    expect(conv("<blockquote>a<blockquote>b</blockquote></blockquote>")).toBe("> a\n>\n> > b");
  });
  it("com lista e código", () => {
    expect(conv("<blockquote><ul><li>a</li></ul><pre><code>x</code></pre></blockquote>")).toBe("> - a\n>\n> ```\n> x\n> ```");
  });
});

describe("hr e br", () => {
  it("hr", () => {
    expect(conv("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });
  it("br vira barra invertida no fim da linha", () => {
    expect(conv("<p>a<br>b</p>")).toBe("a\\\nb");
    expect(conv("<p>a <br> b</p>")).toBe("a\\\nb");
  });
  it("br no fim ou no início do bloco é ignorado", () => {
    expect(conv("<p>a<br></p>")).toBe("a");
    expect(conv("<p><br>a</p>")).toBe("a");
    expect(conv("<p>a<br><br></p><p>b</p>")).toBe("a\n\nb");
    expect(conv("<p><b>a<br></b></p>")).toBe("**a**");
  });
  it("br consecutivos no meio", () => {
    expect(conv("<p>a<br><br>b</p>")).toBe("a\\\n\\\nb");
  });
  it("br dentro de li recua a continuação", () => {
    expect(conv("<ul><li>a<br>b</li></ul>")).toBe("- a\\\n  b");
  });
});

describe("dl/dt/dd", () => {
  it("par simples", () => {
    expect(conv("<dl><dt>Termo</dt><dd>Definição</dd></dl>")).toBe("**Termo**\nDefinição");
  });
  it("múltiplos pares e dd múltiplos", () => {
    expect(conv("<dl><dt>A</dt><dd>um</dd><dd>dois</dd><dt>B</dt><dd>três</dd></dl>")).toBe(
      "**A**\num\n\ndois\n\n**B**\ntrês",
    );
  });
  it("vários dt agrupados", () => {
    expect(conv("<dl><dt>A</dt><dt>B</dt><dd>comum</dd></dl>")).toBe("**A**\n**B**\ncomum");
  });
  it("dt com strong não duplica e dd com bloco", () => {
    expect(conv("<dl><dt><strong>T</strong></dt><dd><p>p1</p><ul><li>x</li></ul></dd></dl>")).toBe("**T**\np1\n\n- x");
  });
  it("dl com div wrapper", () => {
    expect(conv("<dl><div><dt>A</dt><dd>1</dd></div><div><dt>B</dt><dd>2</dd></div></dl>")).toBe("**A**\n1\n\n**B**\n2");
  });
});

describe("escape", () => {
  it("escapa * _ [ ] ` |", () => {
    expect(conv("<p>2 * 3 [x] `y` a|b _z_</p>")).toBe("2 \\* 3 \\[x\\] \\`y\\` a\\|b \\_z\\_");
  });
  it("não escapa _ intrapalavra", () => {
    expect(escapeMarkdown("snake_case_name")).toBe("snake_case_name");
    expect(escapeMarkdown("__init__")).toBe("\\_\\_init\\_\\_");
    expect(escapeMarkdown("a_ b")).toBe("a\\_ b");
  });
  it("início de linha", () => {
    expect(escapeMarkdown("# título")).toBe("\\# título");
    expect(escapeMarkdown("#hashtag")).toBe("#hashtag");
    expect(escapeMarkdown("> citação")).toBe("\\> citação");
    expect(escapeMarkdown("- item")).toBe("\\- item");
    expect(escapeMarkdown("+ item")).toBe("\\+ item");
    expect(escapeMarkdown("1. item")).toBe("1\\. item");
    expect(escapeMarkdown("2) item")).toBe("2\\) item");
    expect(escapeMarkdown("---")).toBe("\\---");
    expect(escapeMarkdown("a - b 1. c")).toBe("a - b 1. c");
    expect(escapeMarkdown("x-y")).toBe("x-y");
  });
  it("< e & só quando ambíguos, barra invertida", () => {
    expect(escapeMarkdown("a < b")).toBe("a < b");
    expect(escapeMarkdown("<div>")).toBe("\\<div>");
    expect(escapeMarkdown("&amp; & b")).toBe("\\&amp; & b");
    expect(escapeMarkdown("a\\*b")).toBe("a\\\\\\*b");
    expect(escapeMarkdown("C:\\dir")).toBe("C:\\dir");
  });
  it("NBSP e ~~", () => {
    expect(escapeMarkdown("a\u00a0b")).toBe("a b");
    expect(escapeMarkdown("a~~b")).toBe("a\\~\\~b");
  });
  it("td.escape é definido pelo registrar", () => {
    const td = new TurndownService();
    registerInlineRules(td, makeCtx());
    expect(td.escape("a*b")).toBe("a\\*b");
  });
  it("heading que termina em # não vira sequência de fechamento", () => {
    expect(conv("<h2>Linguagem C #</h2>")).toBe("## Linguagem C \\#");
    expect(conv("<h2>C#</h2>")).toBe("## C#");
  });
});

describe("integração", () => {
  it("também funciona com HTML em string (parser do Turndown)", () => {
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
    const ctx = makeCtx();
    registerBlockRules(td, ctx);
    registerInlineRules(td, ctx);
    expect(
      td.turndown('<h2 id="x">T</h2><ul><li><input type="checkbox" checked>a<ul><li>b</li></ul></li></ul><p>x&nbsp;<a href="/a">l</a><br>y</p>'),
    ).toBe('<a id="x"></a>\n## T\n\n- [x] a\n  - b\n\nx [l](https://example.com/a)\\\ny');
  });

  it("documento misto", () => {
    const html = `
      <h1 id="top">Guia</h1>
      <p>Veja <a href="/ref">a referência</a> e use <code>foo()</code>.</p>
      <ul><li>um</li><li>dois<ol><li>a</li></ol></li></ul>
      <pre><code class="language-js">x = 1</code></pre>
      <blockquote><p>nota</p></blockquote>`;
    expect(conv(html)).toBe(
      [
        '<a id="top"></a>',
        "# Guia",
        "",
        "Veja [a referência](https://example.com/ref) e use `foo()`.",
        "",
        "- um",
        "- dois\n  1. a",
        "",
        "```js",
        "x = 1",
        "```",
        "",
        "> nota",
      ].join("\n"),
    );
  });
});
