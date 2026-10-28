import { describe, expect, it } from "vitest";
import { cleanDom } from "../src/stages/clean.js";
import {
  assertUsableContent,
  countScripts,
  extractMain,
  extractMeta,
  parseHtml,
} from "../src/stages/extract.js";
import { Web2mdError } from "../src/errors.js";

const URL_ = "https://example.com/docs/page";
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
const LONG = LOREM.repeat(3);

function doc(html: string, url = URL_): Document {
  return parseHtml(html, url);
}
function cleaned(html: string): Document {
  const d = doc(html);
  cleanDom(d);
  return d;
}
function catchErr(fn: () => void): Web2mdError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Web2mdError);
    return e as Web2mdError;
  }
  throw new Error("expected throw");
}

describe("parseHtml", () => {
  it("não executa scripts", () => {
    const d = doc(`<body><script>document.body.setAttribute('data-ran','1')</script><p>x</p></body>`);
    expect(d.body.getAttribute("data-ran")).toBeNull();
    expect(d.URL).toBe(URL_);
  });
});

describe("extractMeta", () => {
  it("lê title, description, lang, canonical e base", () => {
    const d = doc(`<html lang="pt-BR"><head>
      <title>
        Meu   título
      </title>
      <meta name="description" content="  Uma descrição ">
      <link rel="canonical" href="/canon">
      <base href="/assets/">
    </head><body></body></html>`);
    expect(extractMeta(d, URL_)).toEqual({
      url: URL_,
      title: "Meu título",
      description: "Uma descrição",
      lang: "pt-BR",
      canonical: "https://example.com/canon",
      baseUrl: "https://example.com/assets/",
    });
  });

  it("usa fallbacks og:* e omite campos ausentes", () => {
    const d = doc(`<head><meta property="og:title" content="OG T"><meta property="og:description" content="OG D"></head><body></body>`);
    const m = extractMeta(d, URL_);
    expect(m.title).toBe("OG T");
    expect(m.description).toBe("OG D");
    expect("lang" in m).toBe(false);
    expect("canonical" in m).toBe(false);
    expect(m.baseUrl).toBe(URL_);
  });

  it("campos vazios viram undefined", () => {
    const d = doc(`<html lang=""><head><title> </title><meta name="description" content=""></head><body></body></html>`);
    const m = extractMeta(d, URL_);
    expect(m.title).toBeUndefined();
    expect(m.description).toBeUndefined();
    expect(m.lang).toBeUndefined();
  });

  it("base href absoluto", () => {
    const d = doc(`<head><base href="https://cdn.example.org/x/"></head><body></body>`);
    expect(extractMeta(d, URL_).baseUrl).toBe("https://cdn.example.org/x/");
  });
});

describe("cleanDom", () => {
  it("remove script/style/noscript/svg/button/form", () => {
    const d = cleaned(`<body><script>a()</script><style>p{}</style><noscript><p>ns</p></noscript>
      <svg><path/></svg><button>Go</button><form><input name=q></form><p>keep</p></body>`);
    expect(d.body.innerHTML).not.toMatch(/script|style|noscript|svg|button|form/i);
    expect(d.body.textContent).toContain("keep");
  });

  it("preserva script de matemática do MathJax v2", () => {
    const d = cleaned(`<body><script type="math/tex">x^2</script><script>evil()</script></body>`);
    expect(d.querySelectorAll("script")).toHaveLength(1);
    expect(d.querySelector("script")?.getAttribute("type")).toBe("math/tex");
  });

  it("remove hidden e aria-hidden", () => {
    const d = cleaned(`<body><div hidden>H</div><span aria-hidden="true">icon</span><p>visible</p></body>`);
    expect(d.body.textContent).not.toContain("H");
    expect(d.body.textContent).not.toContain("icon");
    expect(d.body.textContent).toContain("visible");
  });

  it("preserva KaTeX/MathJax mesmo com aria-hidden", () => {
    const d = cleaned(`<body><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow>
      <annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>
      <span class="katex-html" aria-hidden="true">x2</span></span>
      <mjx-container aria-hidden="true"><mjx-assistive-mml><math><mi>y</mi></math></mjx-assistive-mml></mjx-container>
      <div aria-hidden="true"><math><mi>z</mi></math></div></body>`);
    expect(d.querySelector("annotation")).not.toBeNull();
    expect(d.querySelector(".katex-html")).not.toBeNull();
    expect(d.querySelector("mjx-container")).not.toBeNull();
    expect(d.querySelectorAll("math")).toHaveLength(3);
  });

  it("remove iframe de anúncio e preserva YouTube/Vimeo/embed", () => {
    const d = cleaned(`<body>
      <iframe id="ad1" src="https://ads.example.com/x"></iframe>
      <iframe src="https://googleads.g.doubleclick.net/pagead"></iframe>
      <iframe src="https://pagead2.googlesyndication.com/x"></iframe>
      <iframe class="advert-box" src="https://foo.com/frame"></iframe>
      <iframe class="sponsor" src="https://foo.com/s"></iframe>
      <iframe src="https://www.youtube.com/embed/abc"></iframe>
      <iframe src="https://player.vimeo.com/video/1"></iframe>
      <iframe src="https://example.com/embed/chart"></iframe>
      <iframe src="https://example.com/download/loader"></iframe>
    </body>`);
    const srcs = Array.from(d.querySelectorAll("iframe")).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([
      "https://www.youtube.com/embed/abc",
      "https://player.vimeo.com/video/1",
      "https://example.com/embed/chart",
      "https://example.com/download/loader",
    ]);
  });

  it("form pequeno é removido; form que envolve a página é desembrulhado", () => {
    const small = cleaned(`<body><form action="/s"><input name=q><label>Buscar</label></form><p>x</p></body>`);
    expect(small.querySelector("form")).toBeNull();
    expect(small.body.textContent).not.toContain("Buscar");

    const wrap = cleaned(`<body><form id="aspnetForm"><input type="hidden" name="__VIEWSTATE" value="zzz">
      <div><h1>Título</h1><p>${LONG}${LONG}</p></div></form></body>`);
    expect(wrap.querySelector("form")).toBeNull();
    expect(wrap.querySelector("input")).toBeNull();
    expect(wrap.querySelector("h1")?.textContent).toBe("Título");

    const withMain = cleaned(`<body><form><main><p>short</p></main></form></body>`);
    expect(withMain.querySelector("main")).not.toBeNull();
    expect(withMain.querySelector("form")).toBeNull();
  });
});

describe("extractMain", () => {
  it("mode=full devolve body sem remover nav/footer", () => {
    const d = cleaned(`<body><nav>Menu</nav><main><p>${LONG}</p></main><footer>Rodapé</footer></body>`);
    const r = extractMain(d, "full");
    expect(r.strategy).toBe("body");
    expect(r.root).toBe(d.body);
    expect(d.querySelector("nav")).not.toBeNull();
    expect(d.querySelector("footer")).not.toBeNull();
  });

  it("usa <main>", () => {
    const d = cleaned(`<body><nav>Menu</nav><article><p>outro</p></article><main><h1>T</h1><p>${LONG}</p></main></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("main");
    expect(r.root.tagName).toBe("MAIN");
  });

  it("usa <article> e escolhe o de maior texto num feed", () => {
    const d = cleaned(`<body><article id="a"><p>${LOREM}</p></article>
      <article id="b"><p>${LONG}${LONG}</p></article><article id="c"><p>${LOREM}</p></article></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("article");
    expect(r.root.id).toBe("b");
  });

  it("usa [role=main]", () => {
    const d = cleaned(`<body><div id="x">${LOREM}</div><div role="main" id="rm"><p>${LONG}</p></div></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("role-main");
    expect(r.root.id).toBe("rm");
  });

  it("main com pouco texto continua a cadeia (article)", () => {
    const d = cleaned(`<body><main><p>curto</p></main><article id="art"><p>${LONG}</p></article></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("article");
    expect(r.root.id).toBe("art");
  });

  it("cai para Readability sem main/article/role=main", () => {
    const paras = Array.from({ length: 6 }, (_, i) => `<p>Parágrafo ${i}. ${LONG}</p>`).join("");
    const d = cleaned(`<body><div class="side"><a href="/a">Link</a></div>
      <div class="content"><h1>Título do artigo</h1>${paras}</div><div class="footer-links"><a href="/b">B</a></div></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("readability");
    expect(r.root.textContent).toContain("Parágrafo 3");
    expect(r.root.ownerDocument).toBe(d);
  });

  it("cai para o body quando o Readability descarta uma seção inteira de texto", () => {
    const paras = (tag: string) => Array.from({ length: 6 }, (_, i) => `<p>${tag} ${i}. ${LONG}</p>`).join("");
    // "extra-notes" casa com os candidatos improváveis do Readability, que descarta o bloco.
    const d = cleaned(`<body><div class="post">${paras("ALFA")}</div>
      <div class="extra-notes"><h2>Notas</h2>${paras("BETA")}</div></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("body");
    expect(r.root.textContent).toContain("ALFA 3");
    expect(r.root.textContent).toContain("BETA 3");
  });

  it("mantém o Readability quando ele só descarta navegação (links)", () => {
    const paras = Array.from({ length: 6 }, (_, i) => `<p>Parágrafo ${i}. ${LONG}</p>`).join("");
    const links = Array.from({ length: 12 }, (_, i) => `<li><a href="/p${i}">Página de navegação ${i}</a></li>`).join("");
    const d = cleaned(`<body><div class="menu-lateral"><ul>${links}</ul></div>
      <div class="content"><h1>Título do artigo</h1>${paras}</div></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("readability");
    expect(r.root.textContent).not.toContain("Página de navegação");
  });

  it("Readability preserva classes (language-x) com keepClasses", () => {
    const paras = Array.from({ length: 4 }, (_, i) => `<p>Parágrafo ${i}. ${LONG}</p>`).join("");
    const d = cleaned(`<body><div>${paras}<pre><code class="language-ts">const a = 1;</code></pre>${paras}</div></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("readability");
    expect(r.root.querySelector("code.language-ts")).not.toBeNull();
  });

  it("remove nav/header/footer/aside mas preserva avisos", () => {
    const d = cleaned(`<body><main>
      <nav>NAVTEXT</nav><header>HEADERTEXT</header>
      <p>${LONG}</p>
      <aside class="note">NOTICE1</aside>
      <aside role="note">NOTICE2</aside>
      <div class="admonition warning"><p>NOTICE3</p></div>
      <div class="callout"><footer>INSIDECALLOUT</footer></div>
      <aside>SIDEBAR</aside>
      <blockquote><footer>— Autor</footer></blockquote>
      <figure><img src="a.png"><figcaption>c</figcaption></figure>
      <footer>FOOTERTEXT</footer></main></body>`);
    const r = extractMain(d, "article");
    const text = r.root.textContent ?? "";
    for (const gone of ["NAVTEXT", "HEADERTEXT", "SIDEBAR", "FOOTERTEXT"]) expect(text).not.toContain(gone);
    for (const kept of ["NOTICE1", "NOTICE2", "NOTICE3", "INSIDECALLOUT", "— Autor"]) expect(text).toContain(kept);
  });

  it("preserva <header> de artigo com título", () => {
    const d = cleaned(`<body><article><header><h1>Título</h1></header><p>${LONG}</p></article></body>`);
    const r = extractMain(d, "article");
    expect(r.root.querySelector("h1")?.textContent).toBe("Título");
  });

  it("cai para body quando não há nada melhor", () => {
    const d = cleaned(`<body><p>oi</p></body>`);
    const r = extractMain(d, "article");
    expect(r.strategy).toBe("body");
    expect(r.root).toBe(d.body);
  });
});

describe("assertUsableContent", () => {
  const scripts = (n: number) => '<script src="/a.js"></script>'.repeat(n);

  it("conteúdo suficiente passa", () => {
    const d = doc(`<body>${scripts(5)}<main><p>${LONG}</p></main></body>`);
    const n = countScripts(d);
    expect(n).toBe(5);
    cleanDom(d);
    const { root } = extractMain(d, "article");
    expect(() => assertUsableContent(d, root, "article", URL_, n)).not.toThrow();
  });

  it("pouco texto + muitos scripts → JS_REQUIRED (contagem antes de cleanDom)", () => {
    const d = doc(`<body><div id="root"></div>${scripts(4)}</body>`);
    const n = countScripts(d);
    cleanDom(d);
    const { root } = extractMain(d, "full");
    const e = catchErr(() => assertUsableContent(d, root, "full", URL_, n));
    expect(e.code).toBe("JS_REQUIRED");
    expect(e.message).toContain(URL_);
  });

  it("sem scriptCount, conta os scripts ainda presentes", () => {
    const d = doc(`<body><div id="root"></div>${scripts(4)}</body>`);
    expect(catchErr(() => assertUsableContent(d, d.body, "full", URL_)).code).toBe("JS_REQUIRED");
    cleanDom(d);
    expect(catchErr(() => assertUsableContent(d, d.body, "full", URL_)).code).toBe("EMPTY_CONTENT");
  });

  it("vazio sem scripts → EMPTY_CONTENT", () => {
    const d = doc(`<body>  <div> </div> </body>`);
    cleanDom(d);
    const e = catchErr(() => assertUsableContent(d, d.body, "full", URL_, 0));
    expect(e.code).toBe("EMPTY_CONTENT");
    expect(e.message).not.toContain("mode=");
  });

  it("vazio com 1 script (< mínimo) → EMPTY_CONTENT", () => {
    const d = doc(`<body>${scripts(1)}</body>`);
    expect(catchErr(() => assertUsableContent(d, d.body, "full", URL_, 1)).code).toBe("EMPTY_CONTENT");
  });

  it("texto curto mas com imagem e sem scripts passa", () => {
    const d = doc(`<body><img src="a.png"></body>`);
    expect(() => assertUsableContent(d, d.body, "full", URL_, 0)).not.toThrow();
  });

  it("texto curto legítimo sem scripts passa", () => {
    const d = doc(`<body><p>Olá mundo</p></body>`);
    expect(() => assertUsableContent(d, d.body, "full", URL_, 0)).not.toThrow();
  });

  it("article com extração minúscula mas body grande → EMPTY_CONTENT sugerindo mode=full", () => {
    const d = doc(`<body>${scripts(5)}<main><p>curto</p></main><div>${LONG}</div></body>`);
    const n = countScripts(d);
    cleanDom(d);
    const root = d.querySelector("main")!;
    const e = catchErr(() => assertUsableContent(d, root, "article", URL_, n));
    expect(e.code).toBe("EMPTY_CONTENT");
    expect(e.message).toContain('mode="full"');
  });

  it("article vazio e body vazio com scripts → JS_REQUIRED", () => {
    const d = doc(`<body><main></main>${scripts(3)}</body>`);
    const n = countScripts(d);
    cleanDom(d);
    const { root } = extractMain(d, "article");
    expect(catchErr(() => assertUsableContent(d, root, "article", URL_, n)).code).toBe("JS_REQUIRED");
  });
});
