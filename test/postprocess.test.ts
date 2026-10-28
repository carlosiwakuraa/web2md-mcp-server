import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { Web2mdError } from "../src/errors.js";
import { formatLocalIso, makeConvertContext } from "../src/pipeline.js";
import {
  collectLinks,
  ensureSingleH1,
  firstH1,
  paginate,
  postProcess,
  renderDocument,
  renderLinksSection,
} from "../src/stages/postprocess.js";
import { SAVED_FILE_NOTICE } from "../src/untrusted.js";

describe("postProcess", () => {
  it("colapsa mais de duas linhas em branco em duas", () => {
    expect(postProcess("a\n\n\n\n\nb\n")).toBe("a\n\n\nb\n");
    expect(postProcess("a\n\nb\n")).toBe("a\n\nb\n");
  });

  it("remove espaços no fim das linhas e preserva o backslash do br", () => {
    expect(postProcess("linha um  \nlinha dois\\\nlinha três \t\n")).toBe("linha um\nlinha dois\\\nlinha três\n");
  });

  it("garante um único \\n final e remove brancos no início", () => {
    expect(postProcess("\n\n# T\n\ntexto\n\n\n\n")).toBe("# T\n\ntexto\n");
    expect(postProcess("texto")).toBe("texto\n");
    expect(postProcess("  \n\n")).toBe("");
  });

  it("normaliza CRLF", () => {
    expect(postProcess("a\r\n\r\nb\r\n")).toBe("a\n\nb\n");
  });

  it("não altera nada dentro de blocos cercados", () => {
    const md = "antes  \n\n```js\nlet a = 1;   \n\n\n\n\nlet b;  \n```\n\ndepois  \n";
    expect(postProcess(md)).toBe("antes\n\n```js\nlet a = 1;   \n\n\n\n\nlet b;  \n```\n\ndepois\n");
  });

  it("respeita cercas ~~~ e cercas maiores contendo ``` internas", () => {
    const md = "~~~\nx  \n\n\n\ny\n~~~\n\n````\n```\nz  \n```\n````\n";
    expect(postProcess(md)).toBe(md);
  });

  it("não confunde ```code``` inline com uma cerca", () => {
    expect(postProcess("use ```x``` aqui  \n\n\n\nfim\n")).toBe("use ```x``` aqui\n\n\nfim\n");
  });

  it("cerca sem fechamento vai até o fim do documento", () => {
    expect(postProcess("```\na  \n\n\n\nb  \n")).toBe("```\na  \n\n\n\nb  \n");
  });

  it("é idempotente", () => {
    const md = "# T  \n\n\n\n\ntexto\n\n```\ncódigo  \n```\n";
    const once = postProcess(md);
    expect(postProcess(once)).toBe(once);
  });
});

describe("ensureSingleH1", () => {
  it("mantém o primeiro H1 e demove os demais", () => {
    expect(ensureSingleH1("# Um\n\ntexto\n\n# Dois\n\n## Sub\n\n# Três\n", "Fallback")).toBe(
      "# Um\n\ntexto\n\n## Dois\n\n## Sub\n\n## Três\n",
    );
  });

  it("não toca em # dentro de blocos de código", () => {
    const md = "# Um\n\n```sh\n# comentário\n```\n\n# Dois\n";
    expect(ensureSingleH1(md, undefined)).toBe("# Um\n\n```sh\n# comentário\n```\n\n## Dois\n");
  });

  it("insere o título de fallback no topo quando não há H1", () => {
    expect(ensureSingleH1("## Sub\n\ntexto\n", "Meu  Título")).toBe("# Meu Título\n\n## Sub\n\ntexto\n");
  });

  it("não considera # dentro de código como H1 existente", () => {
    expect(ensureSingleH1("```\n# x\n```\n", "T")).toBe("# T\n\n```\n# x\n```\n");
  });

  it("não insere nada sem H1 e sem título", () => {
    expect(ensureSingleH1("## Sub\n", undefined)).toBe("## Sub\n");
    expect(ensureSingleH1("## Sub\n", "   ")).toBe("## Sub\n");
  });

  it("não confunde #hashtag com H1", () => {
    expect(ensureSingleH1("#hashtag texto\n", "T")).toBe("# T\n\n#hashtag texto\n");
  });

  it("reconhece âncora <a id> antes do H1 (mesma linha ou linha anterior)", () => {
    const inline = '<a id="a"></a># Um\n\n<a id="b"></a># Dois\n';
    expect(ensureSingleH1(inline, "T")).toBe('<a id="a"></a># Um\n\n<a id="b"></a>## Dois\n');
    const prev = '<a id="a"></a>\n# Um\n\ntexto\n';
    expect(ensureSingleH1(prev, "T")).toBe(prev);
  });

  it("firstH1 devolve o texto do primeiro H1 fora de cercas", () => {
    expect(firstH1("```\n# no\n```\n\n# Sim #\n")).toBe("Sim");
    expect(firstH1("## só h2\n")).toBeUndefined();
  });
});

describe("collectLinks / renderLinksSection", () => {
  const html = `<div id="r">
    <a href="/a">Alfa   <b>beta</b></a>
    <a href="/a">Alfa beta</a>
    <a href="/a">Outro texto</a>
    <a href="">vazio</a>
    <a href="javascript:void(0)">js</a>
    <a href="#sec">frag</a>
    <a href="/sem-texto"><span> </span></a>
    <a href="/img"><img alt="Logo" src="/l.png"></a>
    <a href="mailto:a@b.com">Email</a>
    <a href="tel:+5511999999999">Ligue</a>
    <a>sem href</a>
  </div>`;
  const root = new JSDOM(html).window.document.getElementById("r")!;
  const ctx = makeConvertContext("https://ex.com/docs/p");

  it("coleta absolutos, deduplica por (href,texto) e ignora inválidos", () => {
    expect(collectLinks(root, ctx.resolveUrl)).toEqual([
      { text: "Alfa beta", href: "https://ex.com/a" },
      { text: "Outro texto", href: "https://ex.com/a" },
      { text: "Logo", href: "https://ex.com/img" },
      { text: "Email", href: "mailto:a@b.com" },
      { text: "Ligue", href: "tel:+5511999999999" },
    ]);
  });

  it("renderiza a seção com escape de colchetes", () => {
    const out = renderLinksSection([
      { text: "Guia [beta]", href: "https://ex.com/g" },
      { text: "Wiki", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
    ]);
    expect(out).toBe(
      "## Links da página\n\n- [Guia \\[beta\\]](https://ex.com/g)\n- [Wiki](https://en.wikipedia.org/wiki/Foo_(bar))\n",
    );
  });

  it("devolve string vazia sem links", () => {
    expect(renderLinksSection([])).toBe("");
  });
});

describe("makeConvertContext", () => {
  const ctx = makeConvertContext("https://ex.com/base/");
  it("resolve relativos, preserva fragmentos e valores inválidos", () => {
    expect(ctx.resolveUrl("x/y.png")).toBe("https://ex.com/base/x/y.png");
    expect(ctx.resolveUrl("//cdn.ex.com/a")).toBe("https://cdn.ex.com/a");
    expect(ctx.resolveUrl("#secao")).toBe("#secao");
    expect(ctx.resolveUrl("http://[bad")).toBe("http://[bad");
  });
});

describe("renderDocument", () => {
  const base = {
    url: "https://ex.com/docs/p",
    fetched_at: "2026-10-20T22:32:00-03:00",
    source: "html" as const,
  };

  it("segue a ordem do template e omite campos ausentes", () => {
    const out = renderDocument(
      { ...base, canonical: "https://ex.com/docs/p", title: "Título", lang: "pt-BR" },
      "# Título\n",
    );
    expect(out).toBe(
      `---\nurl: https://ex.com/docs/p\ncanonical: https://ex.com/docs/p\ntitle: Título\nlang: pt-BR\nfetched_at: 2026-10-20T22:32:00-03:00\nsource: html\n---\n\n${SAVED_FILE_NOTICE}\n\n# Título\n`,
    );
  });

  it("coloca entre aspas valores com ':', '#', aspas e quebras de linha", () => {
    const out = renderDocument(
      {
        ...base,
        title: "Guia: começando",
        description: 'Diz "oi" # e\nquebra',
      },
      "x\n",
    );
    expect(out).toContain('title: "Guia: começando"\n');
    expect(out).toContain('description: "Diz \\"oi\\" # e\\nquebra"\n');
  });

  it("protege escalares ambíguos em YAML", () => {
    const out = renderDocument({ ...base, title: "2024", description: "true", lang: "- x" }, "x\n");
    expect(out).toContain('title: "2024"\n');
    expect(out).toContain('description: "true"\n');
    expect(out).toContain('lang: "- x"\n');
  });

  it("URLs com ':' simples ficam sem aspas", () => {
    expect(renderDocument({ ...base, url: "https://ex.com/a?b=c#d" }, "x\n")).toContain("url: https://ex.com/a?b=c#d\n");
  });
});

describe("formatLocalIso", () => {
  it("usa o offset local no formato ±HH:MM, nunca Z", () => {
    expect(formatLocalIso(new Date(2026, 9, 20, 22, 32, 5))).toMatch(/^2026-10-20T22:32:05[+-]\d{2}:\d{2}$/);
    expect(formatLocalIso()).not.toMatch(/Z$/);
  });
});

describe("paginate", () => {
  const para = (n: number) => `Parágrafo ${n}: ${"palavra ".repeat(20).trim()}.`;
  const doc = Array.from({ length: 40 }, (_, i) => para(i)).join("\n\n") + "\n";

  it("devolve tudo sem marcador quando cabe", () => {
    const r = paginate("curto\n", 0, 1000);
    expect(r).toEqual({ text: "curto\n", total_chars: 6, next_start_index: null });
  });

  it("documento vazio devolve texto vazio", () => {
    expect(paginate("", 0, 100)).toEqual({ text: "", total_chars: 0, next_start_index: null });
  });

  it("trunca com o marcador no formato exato", () => {
    const r = paginate(doc, 0, 500);
    expect(r.next_start_index).not.toBeNull();
    expect(r.total_chars).toBe(doc.length);
    const n = r.next_start_index!;
    expect(r.text.endsWith(
      `\n\n---\n[Conteúdo truncado: exibidos caracteres 0–${n} de ${doc.length}. Para continuar, chame novamente com start_index=${n}]\n`,
    )).toBe(true);
    expect(n).toBeLessThanOrEqual(500);
  });

  it("corta em limite de parágrafo quando há um nos últimos ~15%", () => {
    const short = Array.from({ length: 60 }, (_, i) => `Par ${String(i).padStart(2, "0")} com texto curto.`).join("\n\n") + "\n";
    const r = paginate(short, 0, 500);
    const n = r.next_start_index!;
    expect(n).toBeGreaterThanOrEqual(500 - 75);
    expect(n).toBeLessThanOrEqual(500);
    expect(short.slice(n - 2, n)).toBe("\n\n");
  });

  it("cai para limite de linha quando não há parágrafo na janela", () => {
    const d = "linha1 aaaa\nlinha2 bbbb\nlinha3 cccc\nlinha4 dddd\n";
    const r = paginate(d, 0, 40);
    expect(r.next_start_index).toBe(36);
    expect(d.slice(0, 36).endsWith("\n")).toBe(true);
  });

  it("corte duro quando não há quebras, sem partir par substituto", () => {
    const d = "😀".repeat(50);
    const r = paginate(d, 0, 11);
    expect(r.next_start_index! % 2).toBe(0);
    expect(r.next_start_index).toBe(10);
  });

  it("continuação por next_start_index não perde nem duplica texto", () => {
    for (const maxChars of [100, 333, 500, 1200]) {
      let start = 0;
      let rebuilt = "";
      let guard = 0;
      for (;;) {
        const r = paginate(doc, start, maxChars);
        const end = r.next_start_index ?? doc.length;
        const expected = doc.slice(start, end);
        if (r.next_start_index === null) {
          expect(r.text).toBe(expected);
        } else {
          expect(r.text.startsWith(expected.trimEnd())).toBe(true);
          expect(r.next_start_index).toBeGreaterThan(start);
        }
        rebuilt += expected;
        if (r.next_start_index === null) break;
        start = r.next_start_index;
        if (++guard > 1000) throw new Error("loop");
      }
      expect(rebuilt).toBe(doc);
    }
  });

  it("não repete o frontmatter em páginas seguintes", () => {
    const full = renderDocument(
      { url: "https://ex.com/", fetched_at: "2026-10-20T22:32:00-03:00", source: "html" },
      doc,
    );
    const first = paginate(full, 0, 400);
    expect(first.text.startsWith("---\nurl:")).toBe(true);
    const second = paginate(full, first.next_start_index!, 400);
    expect(second.text).not.toContain("fetched_at:");
    expect(second.text.startsWith("---")).toBe(false);
  });

  it("start_index além do fim lança INVALID_ARGUMENT explicando o tamanho total", () => {
    try {
      paginate("abc\n", 4, 100);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Web2mdError);
      expect((e as Web2mdError).code).toBe("INVALID_ARGUMENT");
      expect((e as Web2mdError).message).toContain("4 caracteres no total");
    }
    expect(() => paginate("abc\n", 99, 100)).toThrow(Web2mdError);
  });

  it("start_index negativo/não inteiro e max_chars inválido lançam INVALID_ARGUMENT", () => {
    expect(() => paginate("abc", -1, 10)).toThrow(Web2mdError);
    expect(() => paginate("abc", 0.5, 10)).toThrow(Web2mdError);
    expect(() => paginate("abc", 0, 0)).toThrow(Web2mdError);
  });
});
