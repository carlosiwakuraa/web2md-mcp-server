import type { CallToolResult } from "@modelcontextprotocol/server";
import { decideDispatch, planGroups, renderBatchText, slugFromFileName } from "./batch-plan.js";
import type { BatchDeps, BatchItem, BatchStructured, InlineDoc, PipelineResult } from "./batch-types.js";
import { BATCH_CONCURRENCY } from "./constants.js";
import { outputFileName, resolveOutputDir, saveConversion } from "./output.js";
import { runPipeline } from "./pipeline.js";
import type { BatchInput } from "./schemas/batch-input.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Executa `worker` sobre `items` com no máximo `limit` execuções simultâneas; resultados na ordem de entrada. */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: size }, lane));
  return results;
}

interface Converted {
  item: BatchItem;
  /** Texto paginado (max_chars). Mantido FORA do item/structuredContent: só vira saída no despacho inline. */
  text: string | null;
}

/**
 * Converte várias URLs em Markdown. Nunca lança: erro de uma URL vira item "error".
 *
 * Invariante: o texto dos documentos só entra no resultado quando dispatch === "inline"
 * (via `inlineDocs`); em "saved" e "subagents" o texto nunca é passado a renderBatchText
 * e os itens do structuredContent só carregam metadados.
 */
export async function handleBatch(input: BatchInput, deps: BatchDeps = {}): Promise<CallToolResult> {
  const run = deps.run ?? runPipeline;
  const save = deps.save ?? ((document: string, pageUrl: string, mode: BatchInput["mode"]) => saveConversion(document, pageUrl, mode));
  const concurrency = deps.concurrency ?? BATCH_CONCURRENCY;

  const urls = [...new Set(input.urls)];

  const convertOne = async (url: string): Promise<Converted> => {
    let page: PipelineResult;
    try {
      page = await run({
        url,
        mode: input.mode,
        max_chars: input.max_chars,
        start_index: 0,
        include_links: input.include_links,
        return_content: true,
      });
    } catch (err) {
      return {
        text: null,
        item: {
          url,
          final_url: null,
          slug: slugFromFileName(outputFileName(url, input.mode)),
          status: "error",
          title: null,
          source: null,
          total_chars: null,
          saved_path: null,
          error: errorMessage(err),
        },
      };
    }

    // Documento COMPLETO em disco. Se a gravação falhar o item continua "ok" (o texto
    // ainda pode ir inline), mas sem saved_path ele fica fora do plano de subagentes,
    // que depende de um arquivo para os subagentes lerem.
    let savedPath: string | null = null;
    try {
      savedPath = await save(page.document, page.url, input.mode);
    } catch (saveErr) {
      console.error("[web2md] lote: não foi possível salvar a conversão:", saveErr);
    }

    return {
      text: page.text,
      item: {
        url,
        final_url: page.url,
        slug: slugFromFileName(outputFileName(page.url, input.mode)),
        status: "ok",
        title: page.title ?? null,
        source: page.source === "native-markdown" ? "native-markdown" : "html",
        total_chars: page.total_chars,
        saved_path: savedPath,
        error: null,
      },
    };
  };

  const converted = await runPool(urls, concurrency, (url) =>
    // convertOne já captura erros; o catch é defesa final para nunca derrubar o lote.
    convertOne(url).catch(
      (err): Converted => ({
        text: null,
        item: {
          url,
          final_url: null,
          slug: slugFromFileName(outputFileName(url, input.mode)),
          status: "error",
          title: null,
          source: null,
          total_chars: null,
          saved_path: null,
          error: errorMessage(err),
        },
      }),
    ),
  );

  const items = converted.map((c) => c.item);
  const succeeded = items.filter((i) => i.status === "ok").length;
  const dispatch = decideDispatch(succeeded, input.return_content, input.inline_max_files);

  const structured: BatchStructured = {
    dispatch,
    total: urls.length,
    succeeded,
    failed: urls.length - succeeded,
    output_dir: deps.outputDir ?? resolveOutputDir(),
    objective: input.objective ?? null,
    items,
    groups: dispatch === "subagents" ? planGroups(items, input.files_per_agent) : [],
  };

  const inlineDocs: InlineDoc[] =
    dispatch === "inline"
      ? converted.flatMap((c) =>
          c.item.status === "ok" && c.text !== null ? [{ slug: c.item.slug, url: c.item.url, text: c.text }] : [],
        )
      : [];

  return {
    ...(succeeded === 0 ? { isError: true } : {}),
    content: [{ type: "text", text: renderBatchText(structured, inlineDocs) }],
    structuredContent: structured,
  };
}
