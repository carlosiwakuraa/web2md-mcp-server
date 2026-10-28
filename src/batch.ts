import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { decideDispatch, planGroups, renderBatchText, slugFromFileName, truncateInline } from "./batch-plan.js";
import type { BatchDeps, BatchItem, BatchStructured, InlineDoc } from "./batch-types.js";
import { BATCH_CONCURRENCY, BATCH_DEADLINE_MS, FETCH_TIMEOUT_MS } from "./constants.js";
import { outputFileName, resolveOutputDir, saveConversion } from "./output.js";
import { runPipeline } from "./pipeline.js";
import type { BatchInput } from "./schemas/batch-input.js";
import type { Mode } from "./types.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Executa `worker` sobre `items` com no máximo `limit` execuções simultâneas, gravando cada
 * resultado em `results[índice]` (ordem de entrada; posições não concluídas ficam `undefined`).
 * Depois de `isStopped()` nenhuma nova execução começa e conclusões tardias são descartadas.
 */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  isStopped: () => boolean,
  results: Array<R | undefined>,
): Promise<void> {
  let next = 0;
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const lane = async (): Promise<void> => {
    while (!isStopped() && next < items.length) {
      const index = next++;
      const result = await worker(items[index] as T);
      if (isStopped()) return;
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: size }, lane));
}

interface Converted {
  item: BatchItem;
  /** Texto inline (documento completo truncado em max_chars). Fora do item/structuredContent: só vira saída no despacho inline. */
  text: string | null;
}

function errorItem(url: string, mode: Mode, err: unknown): Converted {
  return {
    text: null,
    item: {
      url,
      final_url: null,
      slug: slugFromFileName(outputFileName(url, mode)),
      status: "error",
      title: null,
      source: null,
      total_chars: null,
      saved_path: null,
      error: errorMessage(err),
    },
  };
}

/** Remove o fragmento (`#...`), que nunca é enviado ao servidor. */
function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * Converte várias URLs em Markdown. Nunca lança: erro de uma URL vira item "error".
 *
 * Invariante: o texto dos documentos só entra no resultado quando dispatch === "inline"
 * (via `inlineDocs`); em "saved" e "subagents" o texto nunca é passado a renderBatchText
 * e os itens do structuredContent só carregam metadados. Item "ok" sempre tem saved_path.
 */
export async function handleBatch(input: BatchInput, deps: BatchDeps = {}): Promise<CallToolResult> {
  const startedAt = Date.now();
  const deadlineMs = deps.deadlineMs ?? BATCH_DEADLINE_MS;
  const outputDir = deps.outputDir ?? resolveOutputDir();
  const concurrency = deps.concurrency ?? BATCH_CONCURRENCY;
  const run =
    deps.run ??
    ((runInput) =>
      runPipeline(runInput, {
        timeoutMs: Math.max(1, Math.min(FETCH_TIMEOUT_MS, startedAt + deadlineMs - Date.now())),
      }));
  const save = deps.save ?? ((document, pageUrl, mode) => saveConversion(document, pageUrl, mode, outputDir));

  // Deduplica por URL sem fragmento, mantendo a ordem e a primeira ocorrência (como pedida).
  const seen = new Set<string>();
  const urls = input.urls.filter((url) => {
    const key = withoutFragment(url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let expired = false;
  // URLs distintas que convergem (redirect) para o mesmo arquivo compartilham uma única gravação.
  const saves = new Map<string, Promise<string>>();

  // Idempotente por arquivo de destino (nome derivado da URL final + modo, hash de 64 bits).
  const saveOnce = (document: string, pageUrl: string): Promise<string> => {
    const key = outputFileName(pageUrl, input.mode);
    let pending = saves.get(key);
    if (!pending) {
      // Depois do prazo nenhuma gravação nova começa.
      if (expired) return Promise.reject(new Error("Prazo do lote esgotado"));
      pending = (async () => {
        // Só o saver padrão: sabemos o destino e se o arquivo já existia antes desta gravação.
        const target = deps.save ? null : path.join(outputDir, key);
        const existed = target ? await lstat(target).then(() => true, () => false) : true;
        const saved = await save(document, pageUrl, input.mode);
        // Gravação iniciada no prazo que terminou depois: o item foi descartado, então o arquivo
        // recém-criado é órfão (um arquivo que já existia é de outra chamada e fica).
        if (expired && target && !existed) await rm(saved, { force: true }).catch(() => undefined);
        return saved;
      })();
      saves.set(key, pending);
    }
    return pending;
  };

  const convertOne = async (url: string): Promise<Converted> => {
    try {
      const page = await run({
        url,
        mode: input.mode,
        max_chars: input.max_chars,
        start_index: 0,
        include_links: input.include_links,
        return_content: true,
      });
      // Conclusão tardia: não grava arquivo nem altera o resultado (já devolvido ao cliente).
      if (expired) return errorItem(url, input.mode, "Prazo do lote esgotado");

      const slug = slugFromFileName(outputFileName(page.url, input.mode));
      let savedPath: string;
      try {
        savedPath = await saveOnce(page.document, page.url);
      } catch (saveErr) {
        throw new Error(`Convertida, mas não foi possível salvar o arquivo: ${errorMessage(saveErr)}`);
      }

      return {
        // Documento completo, nunca page.text (que carrega o marcador de start_index, inexistente no lote).
        text: truncateInline(page.document, input.max_chars, savedPath),
        item: {
          url,
          final_url: page.url,
          slug,
          status: "ok",
          title: page.title ?? null,
          source: page.source === "native-markdown" ? "native-markdown" : "html",
          total_chars: page.total_chars,
          saved_path: savedPath,
          error: null,
        },
      };
    } catch (err) {
      return errorItem(url, input.mode, err);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, deadlineMs);
    timer.unref?.();
  });
  const results = new Array<Converted | undefined>(urls.length);
  try {
    // Corrida: o lote retorna no prazo mesmo que alguma URL ainda esteja em andamento.
    // Depois do prazo, runPool descarta conclusões tardias; o que faltou vira erro abaixo.
    await Promise.race([runPool(urls, concurrency, convertOne, () => expired, results), deadline]);
  } finally {
    clearTimeout(timer);
  }

  const timeoutMessage = `Prazo do lote (${deadlineMs / 1000} s) esgotado antes de concluir esta URL`;
  const converted = urls.map((url, i) => results[i] ?? errorItem(url, input.mode, timeoutMessage));

  const items = converted.map((c) => c.item);
  const okItems = items.filter((i) => i.status === "ok");
  const succeeded = okItems.length;
  // O despacho depende de arquivos distintos: URLs que convergem para o mesmo slug são um arquivo só.
  const distinctFiles = new Set(okItems.map((i) => i.slug)).size;
  const dispatch = decideDispatch(distinctFiles, input.return_content, input.inline_max_files);

  const structured: BatchStructured = {
    dispatch,
    total: urls.length,
    succeeded,
    failed: urls.length - succeeded,
    output_dir: outputDir,
    objective: input.objective ?? null,
    items,
    groups: dispatch === "subagents" ? planGroups(items, input.files_per_agent) : [],
  };

  const inlineSlugs = new Set<string>();
  const inlineDocs: InlineDoc[] = [];
  if (dispatch === "inline") {
    for (const c of converted) {
      if (c.item.status !== "ok" || c.text === null || inlineSlugs.has(c.item.slug)) continue;
      inlineSlugs.add(c.item.slug);
      inlineDocs.push({ slug: c.item.slug, url: c.item.url, text: c.text });
    }
  }

  return {
    ...(succeeded === 0 ? { isError: true } : {}),
    content: [{ type: "text", text: renderBatchText(structured, inlineDocs) }],
    structuredContent: structured,
  };
}
