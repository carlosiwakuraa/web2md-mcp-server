import { describe, expect, it } from "vitest";
import { MAX_STRUCTURED_HEADINGS, convertHtml, runPipeline } from "../src/pipeline.js";
import {
  foldText,
  matchFragment,
  parseHeadings,
  plainText,
  renderOutline,
  resolveSection,
  shiftHeadings,
  slugify,
  sliceSection,
  subtree,
} from "../src/stages/outline.js";
import { Web2mdError } from "../src/errors.js";
import type { ToolInput } from "../src/types.js";

describe("slugify / plainText", () => {
  it("minúsculas, sem acentos, hífens", () => {
    expect(slugify("Instalação e Uso Básico!")).toBe("instalacao-e-uso-basico");
    expect(slugify("  API -- v2 (beta)  ")).toBe("api-v2-beta");
    expect(slugify("???")).toBe("");
    expect(foldText("  AÇÃO   Rápida ")).toBe("acao rapida");
  });

  it("remove marcação inline do texto do heading", () => {
    expect(plainText("Usando **negrito**, `código` e [link](https://x.y/z)")).toBe("Usando negrito, código e link");
    expect(plainText("snake\\_case e \\*literal\\*")).toBe("snake_case e *literal*");
  });
});

describe("parseHeadings", () => {
  it("ATX com níveis, fechamento e intervalos de seção", () => {
    const md = "# Doc\n\nIntro.\n\n## A\n\ntexto A\n\n### A1 ##\n\nfundo\n\n## B\n\ntexto B\n";
    const hs = parseHeadings(md);
    expect(hs.map((h) => [h.level, h.text, h.slug])).toEqual([
      [1, "Doc", "doc"],
      [2, "A", "a"],
      [3, "A1", "a1"],
      [2, "B", "b"],
    ]);
    const [doc, a, a1, b] = hs;
    expect(sliceSection(md, a!)).toBe("## A\n\ntexto A\n\n### A1 ##\n\nfundo\n");
    expect(sliceSection(md, a1!)).toBe("### A1 ##\n\nfundo\n");
    expect(sliceSection(md, b!)).toBe("## B\n\ntexto B\n");
    expect(doc!.start).toBe(0);
    expect(doc!.end).toBe(md.length);
    expect(a!.chars).toBe(a!.end - a!.start);
  });

  it("setext (=== e ---), inclusive em várias linhas", () => {
    const md = "Título\n======\n\nIntro\n\nSub seção\n---------\n\ncorpo\n\nLinha um\nlinha dois\n---\n\nfim\n";
    const hs = parseHeadings(md);
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [1, "Título"],
      [2, "Sub seção"],
      [2, "Linha um linha dois"],
    ]);
    expect(sliceSection(md, hs[1]!)).toBe("Sub seção\n---------\n\ncorpo\n");
  });

  it("--- depois de linha em branco é régua, não heading; listas e tabelas não viram setext", () => {
    const md = "# T\n\ntexto\n\n---\n\n- item\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(parseHeadings(md).map((h) => h.text)).toEqual(["T"]);
  });

  it("ignora # dentro de blocos de código cercados (``` e ~~~, inclusive aninhados por tamanho)", () => {
    const md =
      "# T\n\n```bash\n# comentário\nTexto\n---\n```\n\n~~~\n## falso\n~~~\n\n````md\n```\n# ainda código\n```\n````\n\n## Real\n\nok\n";
    const hs = parseHeadings(md);
    expect(hs.map((h) => h.text)).toEqual(["T", "Real"]);
    expect(sliceSection(md, hs[0]!)).toContain("# ainda código");
    expect(sliceSection(md, hs[1]!)).toBe("## Real\n\nok\n");
  });

  it("duplicados ganham sufixo -1, -2 e slugs vazios viram 'secao'", () => {
    const md = "# T\n\n## Exemplo\n\na\n\n## Exemplo\n\nb\n\n### Exemplo\n\nc\n\n## !!!\n\n## ???\n";
    expect(parseHeadings(md).map((h) => h.slug)).toEqual(["t", "exemplo", "exemplo-1", "exemplo-2", "secao", "secao-1"]);
  });

  it("slug sufixado não colide com heading literal igual", () => {
    const md = "## A\n\n## A\n\n## A-1\n";
    expect(parseHeadings(md).map((h) => h.slug)).toEqual(["a", "a-1", "a-1-1"]);
  });

  it("linha <a id> imediatamente antes do heading vira id e entra na seção", () => {
    const md = '# T\n\n<a id="instalacao"></a>\n## Instalação\n\npassos\n\n## Outro\n';
    const hs = parseHeadings(md);
    expect(hs[1]!.id).toBe("instalacao");
    expect(hs[1]!.slug).toBe("instalacao");
    expect(sliceSection(md, hs[1]!)).toBe('<a id="instalacao"></a>\n## Instalação\n\npassos\n');
    expect(hs[0]!.end).toBe(md.length);
  });

  it("âncora na mesma linha do H1 e múltiplas âncoras", () => {
    const md = '<a id="topo"></a># Início\n\n<a id="a1"></a><a id="a2"></a>\n## Dois\n';
    const hs = parseHeadings(md);
    expect(hs.map((h) => [h.text, h.id])).toEqual([
      ["Início", "topo"],
      ["Dois", "a1"],
    ]);
  });

  it("sem headings devolve lista vazia", () => {
    expect(parseHeadings("só texto\n\noutro\n")).toEqual([]);
    expect(parseHeadings("")).toEqual([]);
  });

  it("funciona sobre o resultado real da conversão HTML (ids dos headings)", () => {
    const html = `<html><body><h1>Documento</h1><p>Intro.</p><h2 id="instalacao">Instalação</h2><p>Passos.</p><h3 id="uso-basico">Uso básico</h3><h2>Sem id</h2></body></html>`;
    const { body } = convertHtml(html, "https://exemplo.com/p", { mode: "full", includeLinks: false });
    const hs = parseHeadings(body);
    expect(hs.map((h) => [h.level, h.slug, h.id])).toEqual([
      [1, "documento", null],
      [2, "instalacao", "instalacao"],
      [3, "uso-basico", "uso-basico"],
      [2, "sem-id", null],
    ]);
    expect(sliceSection(body, hs[1]!)).toBe(
      '<a id="instalacao"></a>\n## Instalação\n\nPassos.\n\n<a id="uso-basico"></a>\n### Uso básico\n',
    );
  });
});

const DOC =
  "# Guia\n\nIntro\n\n## Instalação\n\na\n\n## Instalação avançada\n\nb\n\n## Configuração\n\nc\n\n### Configuração de rede\n\nd\n\n## API\n\ne\n\n## API REST\n\nf\n";

function errOf(fn: () => unknown): Web2mdError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Web2mdError);
    return e as Web2mdError;
  }
  throw new Error("não lançou");
}

describe("resolveSection", () => {
  const hs = parseHeadings(DOC);

  it("slug exato, texto exato (sem caixa/acento) e id", () => {
    expect(resolveSection(hs, "configuracao").text).toBe("Configuração");
    expect(resolveSection(hs, "CONFIGURAÇÃO").text).toBe("Configuração");
    expect(resolveSection(hs, "## Configuração").text).toBe("Configuração");
    expect(resolveSection(hs, "#api").text).toBe("API");
  });

  it("correspondência exata vence o prefixo (API vs API REST)", () => {
    expect(resolveSection(hs, "api").text).toBe("API");
    expect(resolveSection(hs, "Instalação").text).toBe("Instalação");
  });

  it("prefixo e 'contém' unívocos", () => {
    expect(resolveSection(hs, "instalacao av").text).toBe("Instalação avançada");
    expect(resolveSection(hs, "de rede").text).toBe("Configuração de rede");
    expect(resolveSection(hs, "rest").text).toBe("API REST");
  });

  it("ambíguo: erro em português listando os candidatos", () => {
    const e = errOf(() => resolveSection(hs, "con"));
    expect(e.code).toBe("SECTION_AMBIGUOUS");
    expect(e.message).toContain('"con" é ambígua');
    expect(e.message).toContain("configuracao");
    expect(e.message).toContain("configuracao-de-rede");
    expect(e.message).not.toContain("- api ");
  });

  it("inexistente: erro lista até 10 headings e conta o resto", () => {
    const many = parseHeadings(Array.from({ length: 14 }, (_, i) => `## Tópico ${i}`).join("\n\n") + "\n");
    const e = errOf(() => resolveSection(many, "nada disso"));
    expect(e.code).toBe("SECTION_NOT_FOUND");
    expect(e.message).toContain("não encontrada");
    expect(e.message.match(/^- topico-/gm)).toHaveLength(10);
    expect(e.message).toContain("... e mais 4");
    expect(errOf(() => resolveSection([], "x")).message).toContain("não tem headings");
  });

  it("subtree devolve a seção e as subseções", () => {
    const cfg = resolveSection(hs, "configuracao");
    expect(subtree(hs, cfg).map((h) => h.slug)).toEqual(["configuracao", "configuracao-de-rede"]);
  });
});

describe("matchFragment", () => {
  const md = '# T\n\n<a id="Instalacao-ID"></a>\n## Instalação\n\nx\n\n## Uso básico\n';
  const hs = parseHeadings(md);

  it("casa por id HTML (também sem diferenciar caixa), slug e texto codificado", () => {
    expect(matchFragment(hs, "Instalacao-ID")?.text).toBe("Instalação");
    expect(matchFragment(hs, "instalacao-id")?.text).toBe("Instalação");
    expect(matchFragment(hs, "uso-basico")?.text).toBe("Uso básico");
    expect(matchFragment(hs, "Uso%20b%C3%A1sico")?.text).toBe("Uso básico");
  });

  it("não casa por prefixo e ignora fragmentos desconhecidos ou text fragments", () => {
    expect(matchFragment(hs, "uso")).toBeUndefined();
    expect(matchFragment(hs, "nada")).toBeUndefined();
    expect(matchFragment(hs, ":~:text=Uso")).toBeUndefined();
    expect(matchFragment(hs, "")).toBeUndefined();
  });
});

describe("renderOutline", () => {
  it("lista hierárquica com nível, slug, offset e tamanho", () => {
    const hs = parseHeadings(DOC);
    const out = renderOutline(shiftHeadings(hs, 100), 1000, "Guia");
    expect(out.startsWith("# Outline: Guia\n")).toBe(true);
    expect(out).toContain("Documento completo: 1000 caracteres");
    const lines = out.split("\n");
    const cfg = lines.find((l) => l.includes("`configuracao`"))!;
    const net = lines.find((l) => l.includes("`configuracao-de-rede`"))!;
    expect(cfg).toMatch(/^ {2}- Configuração \(h2\)/);
    expect(net).toMatch(/^ {4}- Configuração de rede \(h3\)/);
    const h = hs.find((x) => x.slug === "configuracao")!;
    expect(cfg).toContain(`offset ${h.start + 100}–${h.end + 100} (${h.chars} caracteres)`);
    expect(lines.find((l) => l.includes("`guia`"))!.startsWith("- Guia (h1)")).toBe(true);
  });

  it("documento sem headings", () => {
    expect(renderOutline([], 10)).toContain("Nenhum heading encontrado.");
  });
});

// ----------------------------------------------------------- pipeline (fetch injetado)

const MD_PAGE = `# Guia\n\nIntro do guia.\n\n## Instalação\n\n${"passo de instalação. ".repeat(60)}\n\n\`\`\`bash\n# comentário que não é heading\nnpm i\n\`\`\`\n\n### Requisitos\n\nNode 20.\n\n## Uso\n\nUse assim.\n\n## Uso avançado\n\nOutra coisa.\n`;

function fakeFetch(markdown: string): typeof fetch {
  return (async () =>
    new Response(markdown, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } })) as typeof fetch;
}

function input(over: Partial<ToolInput> = {}): ToolInput {
  return {
    url: "https://exemplo.com/guia.md",
    mode: "article",
    max_chars: 50_000,
    start_index: 0,
    include_links: false,
    return_content: true,
    ...over,
  };
}

const run = (over: Partial<ToolInput> = {}) => runPipeline(input(over), { fetchImpl: fakeFetch(MD_PAGE) });

describe("runPipeline: outline", () => {
  it("devolve só o índice, com frontmatter e offsets válidos no documento completo", async () => {
    const r = await run({ mode: "outline" });
    expect(r.text.startsWith("---\nurl: https://exemplo.com/guia.md\n")).toBe(true);
    expect(r.text).toContain("mode: outline");
    expect(r.text).toContain("# Outline: Guia");
    expect(r.text).not.toContain("passo de instalação");
    expect(r.text).not.toContain("[Conteúdo truncado");
    expect(r.next_start_index).toBeNull();
    expect(r.total_chars).toBe(r.document.length);
    expect(r.document_chars).toBe(r.document.length);
    expect(r.section).toBeNull();

    const hs = r.headings!;
    expect(hs.map((h) => [h.heading, h.level, h.slug])).toEqual([
      ["Guia", 1, "guia"],
      ["Instalação", 2, "instalacao"],
      ["Requisitos", 3, "requisitos"],
      ["Uso", 2, "uso"],
      ["Uso avançado", 2, "uso-avancado"],
    ]);
    // Os offsets apontam para o texto certo no documento COMPLETO (com frontmatter).
    for (const h of hs) {
      expect(h.chars).toBe(h.end - h.start);
      expect(r.document.slice(h.start, h.end)).toMatch(/^#{1,6} /);
    }
    const inst = hs.find((h) => h.slug === "instalacao")!;
    expect(r.document.slice(inst.start, inst.end)).toContain("npm i");
    expect(r.document.slice(inst.start, inst.end)).toContain("### Requisitos");
    expect(r.document.slice(inst.start, inst.end)).not.toContain("## Uso");
  });

  it("outline + section restringe o índice à seção; o fragmento da URL é ignorado no outline", async () => {
    const r = await run({ mode: "outline", section: "instalacao" });
    expect(r.headings!.map((h) => h.slug)).toEqual(["instalacao", "requisitos"]);
    expect(r.section!.slug).toBe("instalacao");
    expect(r.text).toContain("section: Instalação");
    const f = await run({ mode: "outline", fragment: "uso" });
    expect(f.headings!).toHaveLength(5);
    expect(f.section).toBeNull();
  });

  it("outline não pagina: max_chars/start_index não afetam", async () => {
    const r = await run({ mode: "outline", max_chars: 100, start_index: 99999 });
    expect(r.next_start_index).toBeNull();
    expect(r.headings).toHaveLength(5);
  });
});

describe("runPipeline: section", () => {
  it("por slug: frontmatter com section, heading + subseções, sem blocos cortados", async () => {
    const r = await run({ section: "instalacao" });
    expect(r.text).toMatch(
      /^---\nurl: [^\n]*\n[\s\S]*source: native-markdown\nsection: Instalação\nsection_slug: instalacao\n---\n\n## Instalação\n/,
    );
    expect(r.text).toContain("# comentário que não é heading\nnpm i\n```");
    expect(r.text).toContain("### Requisitos\n\nNode 20.");
    expect(r.text).not.toContain("## Uso");
    expect(r.text).not.toContain("Intro do guia");
    expect(r.section).toMatchObject({ heading: "Instalação", level: 2, slug: "instalacao" });
    expect(r.total_chars).toBe(r.text.length);
    expect(r.document_chars).toBe(r.document.length);
    expect(r.document).not.toContain("section:");
    expect(r.document).toContain("## Uso avançado");
  });

  it("por texto (acento/caixa), prefixo unívoco e exato antes do prefixo", async () => {
    expect((await run({ section: "INSTALACAO" })).section!.slug).toBe("instalacao");
    expect((await run({ section: "requis" })).section!.slug).toBe("requisitos");
    expect((await run({ section: "Uso" })).section!.slug).toBe("uso");
    expect((await run({ section: "uso av" })).section!.slug).toBe("uso-avancado");
  });

  it("ambígua e inexistente viram erro descritivo", async () => {
    await expect(run({ section: "us" })).rejects.toMatchObject({ code: "SECTION_AMBIGUOUS" });
    const e = await run({ section: "zzz" }).catch((x) => x as Web2mdError);
    expect(e).toBeInstanceOf(Web2mdError);
    expect(e.message).toContain("Headings disponíveis");
    expect(e.message).toContain("uso-avancado");
  });

  it("fragmento da URL é usado sem section; não casando, devolve o documento normal; section vence", async () => {
    const byFrag = await run({ fragment: "requisitos" });
    expect(byFrag.section!.slug).toBe("requisitos");
    expect(byFrag.text).toContain("### Requisitos");
    expect(byFrag.text).not.toContain("passo de instalação");

    const miss = await run({ fragment: "nao-existe" });
    expect(miss.section).toBeNull();
    expect(miss.text).toBe(miss.document);

    const both = await run({ fragment: "uso", section: "requisitos" });
    expect(both.section!.slug).toBe("requisitos");
  });

  it("paginação opera dentro da seção e percorre tudo sem perder texto", async () => {
    const full = await run({ section: "instalacao" });
    const first = await run({ section: "instalacao", max_chars: 400 });
    expect(first.next_start_index).not.toBeNull();
    expect(first.text).toContain("section: Instalação");
    expect(first.text).toContain(`de ${full.total_chars}. Para continuar`);
    expect(first.total_chars).toBe(full.total_chars);

    let all = first.text.split("\n\n---\n[Conteúdo truncado")[0]!;
    let next = first.next_start_index;
    while (next !== null) {
      const r = await run({ section: "instalacao", max_chars: 400, start_index: next });
      expect(r.text.startsWith("---\n")).toBe(false);
      expect(r.text).not.toContain("## Uso");
      all += r.text.split("\n\n---\n[Conteúdo truncado")[0]!;
      next = r.next_start_index;
    }
    expect(all).toContain("### Requisitos");
    expect(all).toContain("Node 20.");
    await expect(run({ section: "instalacao", start_index: full.total_chars })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("runPipeline: section sobre HTML", () => {
  const html = `<html><head><title>Pág</title></head><body><main><h1>Pág</h1><p>Intro</p><h2 id="a">Alfa</h2><p>texto alfa</p><h2 id="b">Beta</h2><p>texto beta <a href="/x">link</a></p></main></body></html>`;
  const htmlFetch = (async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;

  it("seção por id HTML; a seção de links é uma seção própria", async () => {
    const r = await runPipeline(input({ url: "https://exemplo.com/p", section: "b", include_links: true }), {
      fetchImpl: htmlFetch,
    });
    expect(r.text).toContain("texto beta");
    expect(r.text).not.toContain("texto alfa");
    expect(r.text).not.toContain("Links da página");
    const links = await runPipeline(
      input({ url: "https://exemplo.com/p", section: "links da pagina", include_links: true }),
      { fetchImpl: htmlFetch },
    );
    expect(links.text).toContain("[link](https://exemplo.com/x)");
  });

  it("fragmento casando com o id do heading", async () => {
    const r = await runPipeline(input({ url: "https://exemplo.com/p", fragment: "a" }), { fetchImpl: htmlFetch });
    expect(r.section!.slug).toBe("alfa");
    expect(r.section!.id).toBe("a");
    expect(r.text).toContain("texto alfa");
    expect(r.text).not.toContain("texto beta");
  });
});

// ------------------------------------------------- outline: max_chars limita o índice

/** Markdown com `n` headings H2 (cada um com um parágrafo curto) sob um H1. */
function bigDoc(n: number): string {
  const parts = ["# Changelog\n\nIntro.\n"];
  for (let i = 0; i < n; i++) parts.push(`## Versão ${i}\n\nNotas da versão ${i}.\n`);
  return parts.join("\n");
}

const runBig = (n: number, over: Partial<ToolInput> = {}) =>
  runPipeline(input({ mode: "outline", ...over }), { fetchImpl: fakeFetch(bigDoc(n)) });

const NOTICE_RE =
  /\[Índice truncado: exibidos (\d+) de (\d+) headings\. Use section="<slug>" numa seção pai, ou aumente max_chars, para ver o restante\]/;

describe("renderOutline: limite de tamanho", () => {
  const hs = parseHeadings(DOC);

  it("sem limite (ou com limite folgado) o resultado é idêntico e sem aviso", () => {
    const free = renderOutline(hs, 1000, "Guia");
    expect(renderOutline(hs, 1000, "Guia", free.length)).toBe(free);
    expect(renderOutline(hs, 1000, "Guia", 100_000)).toBe(free);
    expect(free).not.toContain("Índice truncado");
  });

  it("não cabe: mostra os primeiros N itens inteiros, aviso no fim, nunca acima do limite", () => {
    const free = renderOutline(hs, 1000, "Guia");
    const itemLines = free.split("\n").filter((l) => l.includes("— slug:"));
    let checked = 0;
    for (let max = free.length - 1; max >= 0; max -= 7) {
      const out = renderOutline(hs, 1000, "Guia", max);
      expect(out.length).toBeLessThanOrEqual(max);
      const m = NOTICE_RE.exec(out);
      if (!m) continue; // limites minúsculos degradam o aviso; o teto vale mesmo assim
      checked++;
      const shown = Number(m[1]);
      expect(Number(m[2])).toBe(itemLines.length);
      expect(shown).toBeLessThan(itemLines.length);
      // Cada item exibido é uma linha completa e na ordem original.
      expect(out.split("\n").filter((l) => l.includes("— slug:"))).toEqual(itemLines.slice(0, shown));
      expect(out.trimEnd().endsWith("]")).toBe(true);
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("devolve o maior N possível (um item a mais estouraria)", () => {
    const free = renderOutline(hs, 1000, "Guia");
    const lines = free.split("\n").filter((l) => l.includes("— slug:"));
    const max = free.length - lines[lines.length - 1]!.length - 5;
    const out = renderOutline(hs, 1000, "Guia", max);
    const shown = Number(NOTICE_RE.exec(out)![1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(lines.length);
    // Com mais um item a saída passaria do limite.
    const oneMore = lines.slice(0, shown + 1).join("\n");
    const head = free.slice(0, free.indexOf(lines[0]!));
    const withNext = `${head}${oneMore}\n\n[Índice truncado: exibidos ${shown + 1} de ${lines.length} headings. Use section="<slug>" numa seção pai, ou aumente max_chars, para ver o restante]\n`;
    expect(withNext.length).toBeGreaterThan(max);
  });

  it("limite minúsculo: degrada (sem intro/título) mas respeita o teto", () => {
    for (const max of [1, 40, 100, 160, 250]) {
      expect(renderOutline(hs, 1000, "Guia", max).length).toBeLessThanOrEqual(max);
    }
  });
});

describe("runPipeline: outline com max_chars", () => {
  it("outline pequeno cabe em max_chars: inalterado, sem aviso", async () => {
    const small = await run({ mode: "outline" });
    expect(small.text).not.toContain("Índice truncado");
    const again = await run({ mode: "outline", max_chars: small.text.length });
    expect(again.text).toBe(small.text);
    expect(again.headings_truncated).toBe(false);
  });

  it("outline grande: texto truncado dentro de max_chars, com aviso e contagem correta", async () => {
    const full = await runBig(300, { max_chars: 500_000 });
    expect(full.text).not.toContain("Índice truncado");
    expect(full.text.length).toBeGreaterThan(20_000);

    const r = await runBig(300, { max_chars: 4000 });
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.text.startsWith("---\nurl: https://exemplo.com/guia.md\n")).toBe(true);
    expect(r.text).toContain("mode: outline");
    const m = NOTICE_RE.exec(r.text)!;
    expect(m).not.toBeNull();
    const shown = Number(m[1]);
    expect(Number(m[2])).toBe(301); // H1 + 300 H2
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(301);
    expect(r.text.trimEnd().endsWith("]")).toBe(true);
    // Itens exibidos = linhas de item no texto; corte em limite de item (todas completas e consecutivas).
    const lines = r.text.split("\n").filter((l) => l.includes("— slug:"));
    expect(lines).toHaveLength(shown);
    for (const l of lines) expect(l).toMatch(/\(\d+ caracteres\)$/);
    expect(lines[0]).toContain("`changelog`");
    expect(lines[shown - 1]).toContain(`\`versao-${shown - 2}\``);
    // Ainda é o documento completo nas contagens.
    expect(r.total_chars).toBe(r.document.length);
    expect(r.document_chars).toBe(r.document.length);
    expect(r.next_start_index).toBeNull();
  });

  it("start_index é ignorado (o índice não é paginado)", async () => {
    const a = await runBig(300, { max_chars: 4000 });
    const b = await runBig(300, { max_chars: 4000, start_index: 10_000 });
    expect(b.text).toBe(a.text);
  });

  it("max_chars pequeno: texto continua dentro do limite", async () => {
    for (const max of [100, 300, 600]) {
      const r = await runBig(300, { max_chars: max });
      expect(r.text.length).toBeLessThanOrEqual(max);
      expect(r.text).toContain("Índice truncado");
    }
  });

  it("structuredContent: lista completa abaixo do teto, mesmo que o texto seja truncado", async () => {
    const r = await runBig(300, { max_chars: 4000 });
    expect(r.headings).toHaveLength(301);
    expect(r.headings_truncated).toBe(false);
    expect(r.headings![300]!.slug).toBe("versao-299");
  });

  it("structuredContent: acima de 500 headings a lista é cortada e headings_truncated = true", async () => {
    const r = await runBig(MAX_STRUCTURED_HEADINGS + 100, { max_chars: 20_000 });
    expect(r.headings).toHaveLength(MAX_STRUCTURED_HEADINGS);
    expect(r.headings_truncated).toBe(true);
    expect(NOTICE_RE.exec(r.text)![2]).toBe(String(MAX_STRUCTURED_HEADINGS + 101));
    expect(r.document_chars).toBe(r.document.length);
    const exact = await runBig(MAX_STRUCTURED_HEADINGS - 1, { max_chars: 500_000 });
    expect(exact.headings).toHaveLength(MAX_STRUCTURED_HEADINGS);
    expect(exact.headings_truncated).toBe(false);
  });

  it("section + outline truncado: só a subárvore, contagem sobre a subárvore", async () => {
    const md =
      "# Ref\n\n## Pacote\n\n" +
      Array.from({ length: 120 }, (_, i) => `### Função ${i}\n\ntexto ${i}\n`).join("\n") +
      "\n## Outro\n\nfim\n";
    const r = await runPipeline(input({ mode: "outline", section: "pacote", max_chars: 3000 }), {
      fetchImpl: fakeFetch(md),
    });
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.text).toContain("section_slug: pacote");
    const m = NOTICE_RE.exec(r.text)!;
    expect(Number(m[2])).toBe(121); // Pacote + 120 funções (sem Ref e Outro)
    expect(r.text).not.toContain("`outro`");
    expect(r.headings).toHaveLength(121);
    expect(r.section).toMatchObject({ slug: "pacote" });
    expect(r.total_chars).toBe(r.document.length);
  });

  it("modos article/section não têm headings_truncated", async () => {
    expect((await run()).headings_truncated).toBe(false);
    expect((await run({ section: "uso" })).headings_truncated).toBe(false);
  });
});
