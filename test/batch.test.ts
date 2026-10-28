import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBatch } from "../src/batch.js";
import { saveConversion } from "../src/output.js";
import { runPipeline } from "../src/pipeline.js";
import type { BatchStructured, PipelineResult } from "../src/batch-types.js";
import type { BatchInput } from "../src/schemas/batch-input.js";
import { BatchInputSchema } from "../src/schemas/batch-input.js";
import type { ToolInput } from "../src/types.js";

vi.mock("../src/pipeline.js", () => ({ runPipeline: vi.fn() }));
vi.mock("../src/output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/output.js")>();
  return { ...actual, saveConversion: vi.fn(actual.saveConversion) };
});

const tmp = mkdtempSync(path.join(tmpdir(), "web2md-batch-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
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
    // 2º argumento: AbortSignal do prazo do lote (cancelamento das conversões pendentes).
    expect(run).toHaveBeenCalledWith(
      {
        url: u(1),
        mode: "full",
        max_chars: 2000,
        start_index: 0,
        include_links: true,
        return_content: true,
      },
      expect.any(AbortSignal),
    );
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
    expect(failed.slug).toMatch(/^exemplo\.com_p2-[0-9a-f]{16}$/);
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
    // usa o documento completo (nunca page.text, que carregaria o marcador de start_index)
    for (const url of urls) expect(text).toContain(`${SECRET} ${url} (documento completo)`);
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

  it("falha ao salvar vira item error (sem saved_path nem texto) e não derruba o lote", async () => {
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
    expect(s.succeeded).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.items[1]!.status).toBe("error");
    expect(s.items[1]!.error).toBe("Convertida, mas não foi possível salvar o arquivo: disco cheio");
    expect(s.items[1]!.saved_path).toBeNull();
    // 3 arquivos ok com inline_max_files 3: inline, sem o texto do item que falhou ao salvar
    expect(s.dispatch).toBe("inline");
    expect(textOf(result)).not.toContain(`${SECRET} ${u(2)}`);
    for (const item of s.items.filter((i) => i.status === "ok")) expect(item.saved_path).not.toBeNull();
  });

  it("falha ao salvar com todas as URLs: isError true e nenhum texto no resultado", async () => {
    const save = async () => {
      throw new Error("sem permissão");
    };
    const result = await handleBatch(makeInput([u(1)]), { run: okRun, save });
    expect(result.isError).toBe(true);
    expect(structuredOf(result).items[0]!.error).toContain("sem permissão");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("inline trunca o documento completo com marcador para o saved_path, sem start_index", async () => {
    const long = "x".repeat(500);
    const run = async (input: ToolInput): Promise<PipelineResult> => ({
      ...fakePage(input.url),
      text: `${long.slice(0, 100)}\n\n[chame novamente com start_index=100]`,
      document: long,
    });
    const result = await handleBatch(makeInput([u(1)], { max_chars: 100 }), { run, save: fakeSave });
    const text = textOf(result);
    expect(structuredOf(result).dispatch).toBe("inline");
    expect(text).toContain("x".repeat(100));
    expect(text).not.toContain("x".repeat(101));
    expect(text).not.toContain("start_index");
    expect(text).toContain(`/saved/${encodeURIComponent(u(1))}.md`);
  });

  it("deduplica ignorando o fragmento, mantendo a primeira ocorrência como pedida", async () => {
    const run = vi.fn(okRun);
    const result = await handleBatch(makeInput([`${u(1)}#secao`, u(1), `${u(2)}#a`, `${u(2)}#b`]), {
      run,
      save: fakeSave,
    });
    expect(run).toHaveBeenCalledTimes(2);
    const s = structuredOf(result);
    expect(s.total).toBe(2);
    expect(s.items.map((i) => i.url)).toEqual([`${u(1)}#secao`, `${u(2)}#a`]);
  });

  it("URLs distintas que convergem para o mesmo slug gravam uma única vez e contam como um arquivo", async () => {
    const dest = "https://exemplo.com/destino";
    const run = async (): Promise<PipelineResult> => {
      await new Promise((r) => setTimeout(r, 5));
      return fakePage(dest);
    };
    const save = vi.fn(fakeSave);
    // 4 itens ok, mas 1 arquivo distinto: com inline_max_files 1 ainda é inline
    const urls = [1, 2, 3, 4].map(u);
    const result = await handleBatch(makeInput(urls, { inline_max_files: 1 }), { run, save, concurrency: 4 });
    expect(save).toHaveBeenCalledTimes(1);
    const s = structuredOf(result);
    expect(s.total).toBe(4);
    expect(s.succeeded).toBe(4);
    expect(s.dispatch).toBe("inline");
    expect(new Set(s.items.map((i) => i.saved_path)).size).toBe(1);
    // o documento aparece uma única vez no inline
    expect(textOf(result).split("(documento completo)").length - 1).toBe(1);
  });

  it("slug compartilhado: falha da gravação única derruba todos os itens que a compartilham", async () => {
    const run = async (): Promise<PipelineResult> => fakePage("https://exemplo.com/destino");
    const save = vi.fn(async () => {
      throw new Error("falhou");
    });
    const s = structuredOf(await handleBatch(makeInput([u(1), u(2)]), { run, save }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.items.map((i) => i.status)).toEqual(["error", "error"]);
  });

  it("grava em deps.outputDir quando o save padrão é usado", async () => {
    const dir = path.join(tmp, "custom-out");
    const s = structuredOf(await handleBatch(makeInput([u(1)]), { run: okRun, outputDir: dir }));
    expect(s.output_dir).toBe(dir);
    expect(s.items[0]!.saved_path!.startsWith(dir)).toBe(true);
    expect(readFileSync(s.items[0]!.saved_path!, "utf8")).toContain("(documento completo)");
  });

  describe("prazo global", () => {
    it("URLs não concluídas viram erro, o lote retorna no prazo e as pendentes não iniciam", async () => {
      vi.useFakeTimers();
      const run = vi.fn((input: ToolInput) =>
        input.url === u(1) ? Promise.resolve(fakePage(input.url)) : new Promise<PipelineResult>(() => {}),
      );
      const save = vi.fn(fakeSave);
      const promise = handleBatch(makeInput([u(1), u(2), u(3), u(4)]), {
        run,
        save,
        concurrency: 2,
        deadlineMs: 2000,
      });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      const s = structuredOf(result);
      expect(s.items.map((i) => i.status)).toEqual(["ok", "error", "error", "error"]);
      expect(s.items[1]!.error).toBe("Prazo do lote (2 s) esgotado antes de concluir esta URL");
      expect(s.items[3]!.error).toBe("Prazo do lote (2 s) esgotado antes de concluir esta URL");
      expect(s.succeeded).toBe(1);
      expect(s.failed).toBe(3);
      // u(4) nunca iniciou (a faixa 2 ficou presa em u(2); a 1 pegou u(3))
      expect(run).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("conclusão tardia não grava arquivo nem altera o resultado", async () => {
      vi.useFakeTimers();
      let finish!: (page: PipelineResult) => void;
      const run = () => new Promise<PipelineResult>((resolve) => (finish = resolve));
      const save = vi.fn(fakeSave);
      const promise = handleBatch(makeInput([u(1)]), { run, save, deadlineMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      finish(fakePage(u(1)));
      await vi.advanceTimersByTimeAsync(10);
      expect(save).not.toHaveBeenCalled();
      const s = structuredOf(result);
      expect(s.items[0]!.status).toBe("error");
      expect(s.items[0]!.saved_path).toBeNull();
      expect(result.isError).toBe(true);
    });

    it("gravação iniciada no prazo que termina depois: o arquivo órfão novo é removido", async () => {
      const dir = mkdtempSync(path.join(tmp, "orfao-"));
      const actual = await vi.importActual<typeof import("../src/output.js")>("../src/output.js");
      vi.mocked(saveConversion).mockImplementationOnce(async (...args) => {
        await new Promise((r) => setTimeout(r, 200));
        return actual.saveConversion(...args);
      });
      const s = structuredOf(await handleBatch(makeInput([u(1)]), { run: okRun, outputDir: dir, deadlineMs: 50 }));
      expect(s.items[0]!.status).toBe("error");
      expect(s.items[0]!.saved_path).toBeNull();
      await new Promise((r) => setTimeout(r, 500));
      expect(readdirSync(dir)).toEqual([]);
    });

    it("gravação tardia sobre arquivo que já existia não apaga o arquivo anterior", async () => {
      const dir = mkdtempSync(path.join(tmp, "existente-"));
      const actual = await vi.importActual<typeof import("../src/output.js")>("../src/output.js");
      const previous = await actual.saveConversion("# antigo", u(1), "article", dir);
      vi.mocked(saveConversion).mockImplementationOnce(async (...args) => {
        await new Promise((r) => setTimeout(r, 200));
        return actual.saveConversion(...args);
      });
      await handleBatch(makeInput([u(1)]), { run: okRun, outputDir: dir, deadlineMs: 50 });
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(previous)).toBe(true);
    });

    it("estourar o prazo aborta o AbortSignal das conversões pendentes (não só marca erro)", async () => {
      const signals: AbortSignal[] = [];
      const aborted: string[] = [];
      const run = (input: ToolInput, signal?: AbortSignal) =>
        new Promise<PipelineResult>((_, reject) => {
          signals.push(signal!);
          signal!.addEventListener("abort", () => {
            aborted.push(input.url);
            reject(new Error("cancelada"));
          });
        });
      const result = await handleBatch(makeInput([u(1), u(2)]), { run, save: fakeSave, deadlineMs: 30, concurrency: 2 });
      expect(signals).toHaveLength(2);
      expect(signals.every((s) => s.aborted)).toBe(true);
      expect(aborted.sort()).toEqual([u(1), u(2)]);
      expect(structuredOf(result).items.every((i) => i.status === "error")).toBe(true);
    });

    it("sem estourar o prazo o signal não é abortado", async () => {
      let seen: AbortSignal | undefined;
      const run = async (input: ToolInput, signal?: AbortSignal) => {
        seen = signal;
        return okRun(input);
      };
      await handleBatch(makeInput([u(1)]), { run, save: fakeSave, deadlineMs: 5000 });
      expect(seen).toBeDefined();
      expect(seen!.aborted).toBe(false);
    });

    it("sem estourar o prazo não deixa timer pendente", async () => {
      vi.useFakeTimers();
      await handleBatch(makeInput([u(1)]), { run: okRun, save: fakeSave, deadlineMs: 5000 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("run padrão limita o timeout do fetch ao menor entre FETCH_TIMEOUT_MS e o tempo restante", async () => {
      const mocked = vi.mocked(runPipeline);
      mocked.mockClear();
      mocked.mockImplementation(async (input) => fakePage(input.url));
      await handleBatch(makeInput([u(1)]), { save: fakeSave, deadlineMs: 5000 });
      await handleBatch(makeInput([u(2)]), { save: fakeSave });
      const [first, second] = mocked.mock.calls;
      expect(first![1]!.timeoutMs).toBeLessThanOrEqual(5000);
      expect(first![1]!.timeoutMs).toBeGreaterThan(0);
      expect(second![1]!.timeoutMs).toBe(30_000);
    });
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
    expect(s.items[0]!.slug).toMatch(/^exemplo\.com_destino-[0-9a-f]{16}$/);
  });
});
