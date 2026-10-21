import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBatch } from "../src/batch.js";
import type { BatchStructured, PipelineResult } from "../src/batch-types.js";
import type { BatchInput } from "../src/schemas/batch-input.js";
import { BatchInputSchema } from "../src/schemas/batch-input.js";
import type { ToolInput } from "../src/types.js";

const tmp = mkdtempSync(path.join(tmpdir(), "web2md-batch-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const SECRET = "CONTEUDO-SECRETO-DO-DOCUMENTO";

function makeInput(urls: string[], extra: Partial<BatchInput> = {}): BatchInput {
  return BatchInputSchema.parse({ urls, ...extra });
}

function fakePage(url: string): PipelineResult {
  return {
    text: `${SECRET} ${url}`,
    total_chars: 1234,
    next_start_index: null,
    source: "html",
    url,
    document: `# Titulo\n\n${SECRET} ${url} (documento completo)`,
    title: "Titulo",
  };
}

const okRun = async (input: ToolInput): Promise<PipelineResult> => fakePage(input.url);
const fakeSave = async (_doc: string, pageUrl: string): Promise<string> => `/saved/${encodeURIComponent(pageUrl)}.md`;

const u = (n: number) => `https://exemplo.com/p${n}`;

function structuredOf(result: Awaited<ReturnType<typeof handleBatch>>): BatchStructured {
  return result.structuredContent as unknown as BatchStructured;
}

function textOf(result: Awaited<ReturnType<typeof handleBatch>>): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("handleBatch", () => {
  it("deduplica URLs idênticas preservando a ordem e converte cada uma uma vez", async () => {
    const run = vi.fn(okRun);
    const result = await handleBatch(makeInput([u(1), u(2), u(1), u(3), u(2)]), { run, save: fakeSave, outputDir: "/out" });
    expect(run).toHaveBeenCalledTimes(3);
    const s = structuredOf(result);
    expect(s.total).toBe(3);
    expect(s.items.map((i) => i.url)).toEqual([u(1), u(2), u(3)]);
  });

  it("repassa os parâmetros ao pipeline (start_index 0, return_content true)", async () => {
    const run = vi.fn(okRun);
    await handleBatch(makeInput([u(1)], { mode: "full", include_links: true, max_chars: 2000 }), { run, save: fakeSave });
    expect(run).toHaveBeenCalledWith({
      url: u(1),
      mode: "full",
      max_chars: 2000,
      start_index: 0,
      include_links: true,
      return_content: true,
    });
  });

  it("mantém a ordem original mesmo quando as conversões terminam fora de ordem", async () => {
    const run = async (input: ToolInput) => {
      const n = Number(input.url.slice(-1));
      await new Promise((r) => setTimeout(r, (5 - n) * 8));
      return fakePage(input.url);
    };
    const urls = [1, 2, 3, 4].map(u);
    const s = structuredOf(await handleBatch(makeInput(urls), { run, save: fakeSave, concurrency: 4 }));
    expect(s.items.map((i) => i.url)).toEqual(urls);
  });

  it("isola falhas: uma URL falha, as outras convertem e isError é false", async () => {
    const run = async (input: ToolInput) => {
      if (input.url === u(2)) throw new Error("Erro HTTP 404 ao buscar a página");
      return fakePage(input.url);
    };
    const result = await handleBatch(makeInput([u(1), u(2), u(3)]), { run, save: fakeSave });
    expect(result.isError).toBeUndefined();
    const s = structuredOf(result);
    expect(s.succeeded).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.items.map((i) => i.status)).toEqual(["ok", "error", "ok"]);
    const failed = s.items[1]!;
    expect(failed.error).toBe("Erro HTTP 404 ao buscar a página");
    expect(failed.url).toBe(u(2));
    expect(failed.final_url).toBeNull();
    expect(failed.saved_path).toBeNull();
    expect(failed.slug).toMatch(/^exemplo\.com_p2-[0-9a-f]{8}$/);
  });

  it("devolve isError true (com texto e structuredContent) quando nenhuma URL converte", async () => {
    const run = async () => {
      throw new Error("falha de rede");
    };
    const result = await handleBatch(makeInput([u(1), u(2)]), { run, save: fakeSave });
    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
    const s = structuredOf(result);
    expect(s.succeeded).toBe(0);
    expect(s.failed).toBe(2);
    expect(s.dispatch).toBe("saved");
    expect(s.groups).toEqual([]);
  });

  it("trata rejeições que não são Error sem lançar", async () => {
    const run = async () => {
      throw "texto solto";
    };
    const result = await handleBatch(makeInput([u(1)]), { run, save: fakeSave });
    expect(structuredOf(result).items[0]!.error).toBe("texto solto");
  });

  it("limita a concorrência ao valor configurado", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (input: ToolInput) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return fakePage(input.url);
    };
    const urls = [1, 2, 3, 4, 5, 6, 7].map(u);
    const s = structuredOf(await handleBatch(makeInput(urls), { run, save: fakeSave, concurrency: 2 }));
    expect(maxActive).toBe(2);
    expect(s.succeeded).toBe(7);
  });

  it("dispatch saved (return_content=false): nada do documento no resultado e arquivo completo em disco", async () => {
    const dir = path.join(tmp, "saved");
    const { saveConversion } = await import("../src/output.js");
    const save = (doc: string, url: string, mode: "article" | "full") => saveConversion(doc, url, mode, dir);
    const result = await handleBatch(makeInput([u(1), u(2)], { return_content: false }), {
      run: okRun,
      save,
      outputDir: dir,
    });
    const s = structuredOf(result);
    expect(s.dispatch).toBe("saved");
    expect(s.groups).toEqual([]);
    expect(s.output_dir).toBe(dir);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    for (const item of s.items) {
      expect(item.saved_path).toMatch(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      expect(readFileSync(item.saved_path!, "utf8")).toContain(`${SECRET} ${item.url} (documento completo)`);
    }
  });

  it("dispatch inline com 3 ok e inline_max_files 3: texto paginado no content", async () => {
    const urls = [1, 2, 3].map(u);
    const result = await handleBatch(makeInput(urls, { inline_max_files: 3 }), { run: okRun, save: fakeSave });
    const s = structuredOf(result);
    expect(s.dispatch).toBe("inline");
    expect(s.groups).toEqual([]);
    const text = textOf(result);
    for (const url of urls) expect(text).toContain(`${SECRET} ${url}`);
    // o document completo (com "(documento completo)") nunca é usado: só page.text
    expect(text).not.toContain("(documento completo)");
    // structuredContent só tem metadados
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("dispatch subagents com 4 ok e inline_max_files 3: grupos corretos e nenhum texto de documento vaza", async () => {
    const urls = [1, 2, 3, 4].map(u);
    const result = await handleBatch(
      makeInput(urls, { inline_max_files: 3, files_per_agent: 2, objective: "comparar autenticação" }),
      { run: okRun, save: fakeSave },
    );
    const s = structuredOf(result);
    expect(s.dispatch).toBe("subagents");
    expect(s.groups).toHaveLength(2);
    expect(s.groups.map((g) => g.files.map((f) => f.url))).toEqual([
      [u(1), u(2)],
      [u(3), u(4)],
    ]);
    for (const g of s.groups) {
      for (const f of g.files) {
        expect(f.saved_path).toBe(`/saved/${encodeURIComponent(f.url)}.md`);
      }
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(textOf(result)).not.toContain(SECRET);
    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
  });

  it("repassa o objective (ou null) no structuredContent", async () => {
    const withObj = structuredOf(
      await handleBatch(makeInput([u(1)], { objective: "extrair preços" }), { run: okRun, save: fakeSave }),
    );
    expect(withObj.objective).toBe("extrair preços");
    const without = structuredOf(await handleBatch(makeInput([u(1)]), { run: okRun, save: fakeSave }));
    expect(without.objective).toBeNull();
  });

  it("falha ao salvar não derruba o lote: item segue ok com saved_path null e fica fora do plano de subagentes", async () => {
    const save = async (_doc: string, pageUrl: string) => {
      if (pageUrl === u(2)) throw new Error("disco cheio");
      return `/saved/${encodeURIComponent(pageUrl)}.md`;
    };
    const urls = [1, 2, 3, 4].map(u);
    const result = await handleBatch(makeInput(urls, { inline_max_files: 3, files_per_agent: 5 }), {
      run: okRun,
      save,
    });
    expect(result.isError).toBeUndefined();
    const s = structuredOf(result);
    expect(s.succeeded).toBe(4);
    expect(s.failed).toBe(0);
    expect(s.items[1]!.status).toBe("ok");
    expect(s.items[1]!.saved_path).toBeNull();
    expect(s.dispatch).toBe("subagents");
    expect(s.groups.flatMap((g) => g.files.map((f) => f.url))).toEqual([u(1), u(3), u(4)]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(console.error).toHaveBeenCalled();
  });

  it("falha ao salvar em inline mantém o texto no contexto", async () => {
    const save = async () => {
      throw new Error("sem permissão");
    };
    const result = await handleBatch(makeInput([u(1)]), { run: okRun, save });
    const s = structuredOf(result);
    expect(s.dispatch).toBe("inline");
    expect(s.items[0]!.saved_path).toBeNull();
    expect(textOf(result)).toContain(SECRET);
  });

  it("usa a URL final (redirect) para final_url e para o slug dos itens ok", async () => {
    const run = async (input: ToolInput): Promise<PipelineResult> => ({
      ...fakePage("https://exemplo.com/destino"),
      url: "https://exemplo.com/destino",
      title: input.url,
    });
    const s = structuredOf(await handleBatch(makeInput([u(1)]), { run, save: fakeSave }));
    expect(s.items[0]!.url).toBe(u(1));
    expect(s.items[0]!.final_url).toBe("https://exemplo.com/destino");
    expect(s.items[0]!.slug).toMatch(/^exemplo\.com_destino-[0-9a-f]{8}$/);
  });
});
