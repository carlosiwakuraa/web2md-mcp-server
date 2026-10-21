import { describe, expect, it } from "vitest";
import { decideDispatch, planGroups, renderBatchText, slugFromFileName } from "../src/batch-plan.js";
import type { BatchItem, BatchStructured } from "../src/batch-types.js";

function okItem(n: number, over: Partial<BatchItem> = {}): BatchItem {
  return {
    url: `https://example.com/p${n}`,
    final_url: null,
    slug: `example.com_p${n}-0000abcd`,
    status: "ok",
    title: `Página ${n}`,
    source: "html",
    total_chars: 1000 + n,
    saved_path: `/tmp/out/example.com_p${n}-0000abcd.md`,
    error: null,
    ...over,
  };
}

function errItem(n: number): BatchItem {
  return {
    url: `https://bad.test/e${n}`,
    final_url: null,
    slug: `bad.test_e${n}-1111aaaa`,
    status: "error",
    title: null,
    source: null,
    total_chars: null,
    saved_path: null,
    error: `Falha HTTP ${500 + n}`,
  };
}

function result(over: Partial<BatchStructured>): BatchStructured {
  const items = over.items ?? [];
  const succeeded = items.filter((i) => i.status === "ok").length;
  return {
    dispatch: "saved",
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    output_dir: "/tmp/out",
    objective: null,
    items,
    groups: [],
    ...over,
  };
}

describe("slugFromFileName", () => {
  it("remove só a extensão .md final", () => {
    expect(slugFromFileName("example.com_a-1234abcd.full.md")).toBe("example.com_a-1234abcd.full");
    expect(slugFromFileName("example.com_a-1234abcd.md")).toBe("example.com_a-1234abcd");
    expect(slugFromFileName("a.md.md")).toBe("a.md");
  });

  it("usa o basename de caminhos com diretórios", () => {
    expect(slugFromFileName("/tmp/out/dir.md/example.com_a-1234abcd.md")).toBe("example.com_a-1234abcd");
  });
});

describe("decideDispatch", () => {
  it("return_content=false -> saved", () => {
    expect(decideDispatch(10, false, 3)).toBe("saved");
    expect(decideDispatch(1, false, 3)).toBe("saved");
  });

  it("okCount 0 -> saved", () => {
    expect(decideDispatch(0, true, 3)).toBe("saved");
  });

  it("até inlineMaxFiles -> inline (borda inclusiva)", () => {
    expect(decideDispatch(1, true, 3)).toBe("inline");
    expect(decideDispatch(3, true, 3)).toBe("inline");
  });

  it("acima de inlineMaxFiles -> subagents", () => {
    expect(decideDispatch(4, true, 3)).toBe("subagents");
    expect(decideDispatch(20, true, 1)).toBe("subagents");
  });
});

describe("planGroups", () => {
  it("um arquivo por grupo usa o slug como agent_name", () => {
    const groups = planGroups([okItem(1), okItem(2), okItem(3)], 1);
    expect(groups.map((g) => g.agent_name)).toEqual([okItem(1).slug, okItem(2).slug, okItem(3).slug]);
    expect(groups.every((g) => g.files.length === 1)).toBe(true);
  });

  it("trunca agent_name de grupo unitário em 60 chars", () => {
    const slug = "x".repeat(100);
    const [g] = planGroups([okItem(1, { slug })], 5);
    expect(g.agent_name).toBe("x".repeat(60));
  });

  it("agrupa de 5 em 5, com resto, e nomes web2md-lote-N", () => {
    const items = Array.from({ length: 12 }, (_, i) => okItem(i + 1));
    const groups = planGroups(items, 5);
    expect(groups.map((g) => g.files.length)).toEqual([5, 5, 2]);
    expect(groups.map((g) => g.agent_name)).toEqual(["web2md-lote-1", "web2md-lote-2", "web2md-lote-3"]);
    expect(groups[0].files[0].slug).toBe(okItem(1).slug);
    expect(groups[2].files[1].slug).toBe(okItem(12).slug);
  });

  it("resto de 1 arquivo vira grupo nomeado pelo slug", () => {
    const groups = planGroups(Array.from({ length: 6 }, (_, i) => okItem(i + 1)), 5);
    expect(groups.map((g) => g.agent_name)).toEqual(["web2md-lote-1", okItem(6).slug]);
  });

  it("ignora itens com erro e sem saved_path, mantendo a ordem", () => {
    const items = [okItem(1), errItem(1), okItem(2, { saved_path: null }), okItem(3)];
    const groups = planGroups(items, 5);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map((f) => f.slug)).toEqual([okItem(1).slug, okItem(3).slug]);
  });

  it("usa final_url quando existe e devolve [] sem itens ok", () => {
    const [g] = planGroups([okItem(1, { final_url: "https://example.com/final" })], 5);
    expect(g.files[0]).toEqual({
      slug: okItem(1).slug,
      url: "https://example.com/final",
      saved_path: okItem(1).saved_path,
    });
    expect(planGroups([errItem(1)], 5)).toEqual([]);
  });
});

describe("renderBatchText", () => {
  it("saved: primeira linha, lista com título, chars, caminho e erros", () => {
    const items = [okItem(1), errItem(1)];
    const text = renderBatchText(result({ dispatch: "saved", items }), []);
    expect(text.split("\n")[0]).toBe(
      "Lote concluído: 1 de 2 URLs convertidas. Nada foi trazido ao contexto; os arquivos estão em /tmp/out.",
    );
    expect(text).toContain(okItem(1).slug);
    expect(text).toContain("Página 1");
    expect(text).toContain("1001 chars");
    expect(text).toContain(okItem(1).saved_path as string);
    expect(text).toContain("https://bad.test/e1");
    expect(text).toContain("Falha HTTP 501");
  });

  it("inline: cabeçalho, falhas, documentos sob ## slug e separador, sem alterar o texto", () => {
    const items = [okItem(1), okItem(2), errItem(1)];
    const docs = [
      { slug: okItem(1).slug, url: okItem(1).url, text: "---\ntitle: A\n---\n\n# A\n\ncorpo A" },
      { slug: okItem(2).slug, url: okItem(2).url, text: "# B\n\ncorpo B" },
    ];
    const text = renderBatchText(result({ dispatch: "inline", items }), docs);
    expect(text.startsWith("Lote concluído: 2 de 3 URLs convertidas (conteúdo inline abaixo).")).toBe(true);
    expect(text).toContain("Falha HTTP 501");
    expect(text).toContain(`## ${okItem(1).slug}\nfonte: ${okItem(1).url}\n\n${docs[0].text}`);
    expect(text).toContain(`## ${okItem(2).slug}\nfonte: ${okItem(2).url}\n\n${docs[1].text}`);
    expect(text.split("\n\n---\n\n")).toHaveLength(3);
    // o frontmatter do documento aparece uma única vez
    expect(text.split("title: A")).toHaveLength(2);
  });

  describe("subagents", () => {
    const items = [...Array.from({ length: 6 }, (_, i) => okItem(i + 1)), errItem(1)];
    const groups = planGroups(items, 5);
    const base = result({ dispatch: "subagents", items, groups });

    it("traz banner, explicação e instrução explícita", () => {
      const text = renderBatchText(base, []);
      expect(text.startsWith("ATENÇÃO: o conteúdo convertido NÃO está neste contexto e NÃO deve ser lido aqui.")).toBe(true);
      expect(text).toContain("6 arquivos");
      expect(text).toContain("/tmp/out");
      expect(text).toContain("Não leia os arquivos no contexto principal.");
      expect(text).toContain("Invoque um subagente por grupo abaixo, em paralelo, usando o agent_name indicado.");
      expect(text).toContain("Read");
      expect(text).toContain("sem copiar o documento inteiro");
      expect(text).toContain("Se este cliente não suportar subagentes, avise o usuário em vez de ler os arquivos no contexto principal (ou peça para repetir com return_content=false e inline_max_files maior, ciente do custo de contexto).");
    });

    it("lista cada grupo com agent_name, slug, url e caminho", () => {
      const text = renderBatchText(base, []);
      for (const g of groups) {
        expect(text).toContain(g.agent_name);
        for (const f of g.files) {
          expect(text).toContain(f.slug);
          expect(text).toContain(f.url);
          expect(text).toContain(f.saved_path);
        }
      }
    });

    it("inclui o objetivo quando existe; senão pede resumo estruturado", () => {
      const withObjective = renderBatchText({ ...base, objective: "comparar opções de autenticação" }, []);
      expect(withObjective).toContain("Objetivo do usuário (repasse a cada subagente): comparar opções de autenticação");
      const without = renderBatchText(base, []);
      expect(without).not.toContain("Objetivo do usuário");
      expect(without).toContain("resumo estruturado");
    });

    it("lista as URLs que falharam e NÃO contém texto de documento", () => {
      const docs = [{ slug: okItem(1).slug, url: okItem(1).url, text: "TEXTO-SECRETO-DO-DOCUMENTO" }];
      const text = renderBatchText(base, docs);
      expect(text).toContain("https://bad.test/e1");
      expect(text).toContain("Falha HTTP 501");
      expect(text).not.toContain("TEXTO-SECRETO-DO-DOCUMENTO");
      expect(text).not.toContain("\n---\n");
    });
  });
});
