import { describe, expect, it } from "vitest";
import { convertHtml } from "../src/pipeline.js";
import { parseHtml } from "../src/stages/extract.js";
import { normalizeTabs } from "../src/stages/tabs.js";

const URL_ = "https://exemplo.com/p";
const md = (html: string): string => convertHtml(`<!doctype html><body>${html}</body>`, URL_, { mode: "full", includeLinks: false }).body;

describe("normalizeTabs", () => {
  it("pareia por aria-controls mesmo com os painéis fora de ordem", () => {
    const out = md(`
      <div role="tablist"><button role="tab" aria-controls="p-a">Alfa</button><button role="tab" aria-controls="p-b">Beta</button></div>
      <div role="tabpanel" id="p-b" hidden><p>texto do beta</p></div>
      <div role="tabpanel" id="p-a"><p>texto do alfa</p></div>`);
    expect(out).toContain("**Alfa**\n\ntexto do alfa");
    expect(out).toContain("**Beta**\n\ntexto do beta");
  });

  it("pareia por aria-labelledby", () => {
    const out = md(`
      <div role="tablist"><span role="tab" id="t1">Um</span><span role="tab" id="t2">Dois</span></div>
      <div role="tabpanel" aria-labelledby="t2" hidden><p>segundo</p></div>
      <div role="tabpanel" aria-labelledby="t1"><p>primeiro</p></div>`);
    expect(out).toContain("**Um**\n\nprimeiro");
    expect(out).toContain("**Dois**\n\nsegundo");
  });

  it("revela painéis hidden e remove a lista de abas", () => {
    const out = md(`
      <ul role="tablist"><li role="tab">A</li><li role="tab">B</li></ul>
      <div><div role="tabpanel"><p>conteúdo a</p></div><div role="tabpanel" hidden><p>conteúdo b</p></div></div>`);
    expect(out).toContain("conteúdo b");
    expect(out).not.toMatch(/^- A$/m);
  });

  it("deixa intacto um tablist sem painéis correspondentes (ex.: navegação)", () => {
    const doc = parseHtml(`<body><ul role="tablist"><li role="tab">A</li><li role="tab">B</li></ul><p>x</p></body>`, URL_);
    normalizeTabs(doc);
    expect(doc.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it("deixa intacto o grupo quando rótulos e painéis não casam um a um", () => {
    const doc = parseHtml(
      `<body><div class="vp-code-group"><div class="tabs"><label>a</label><label>b</label></div><div class="blocks"><div>só um</div></div></div></body>`,
      URL_,
    );
    normalizeTabs(doc);
    expect(doc.querySelector(".tabs")).not.toBeNull();
    expect(doc.querySelector("strong")).toBeNull();
  });

  it("trata grupos aninhados do mais interno ao mais externo", () => {
    const out = md(`
      <div role="tablist"><span role="tab">Externa 1</span><span role="tab">Externa 2</span></div>
      <div>
        <div role="tabpanel">
          <div role="tablist"><span role="tab">Interna 1</span><span role="tab">Interna 2</span></div>
          <div><div role="tabpanel"><p>i1</p></div><div role="tabpanel" hidden><p>i2</p></div></div>
        </div>
        <div role="tabpanel" hidden><p>e2</p></div>
      </div>`);
    expect(out).toMatch(/\*\*Externa 1\*\*[\s\S]*\*\*Interna 1\*\*\n\ni1[\s\S]*\*\*Interna 2\*\*\n\ni2[\s\S]*\*\*Externa 2\*\*\n\ne2/);
  });

  it("rótulo vazio não gera linha em negrito", () => {
    const out = md(`
      <ul role="tablist"><li role="tab"></li></ul>
      <div role="tabpanel"><p>corpo</p></div>`);
    expect(out.trim()).toBe("corpo");
  });

  it("não vaza o rótulo de linguagem do VitePress fora de grupos", () => {
    const out = md(`<div class="language-ts"><button class="copy"></button><span class="lang">ts</span><pre><code>let a = 1;</code></pre></div>`);
    expect(out.trim()).toBe("```ts\nlet a = 1;\n```");
  });
});
