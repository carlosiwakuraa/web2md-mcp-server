/**
 * CONTRATO do lote (v1.2). Os módulos batch-plan.ts (puro), batch.ts (I/O) e a
 * tool em index.ts são implementados em paralelo contra estas assinaturas.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import type { BatchGroupSchema, BatchItemSchema, BatchOutputSchema } from "./schemas/batch-input.js";
import type { Mode, ToolInput } from "./types.js";

export type BatchItem = z.infer<typeof BatchItemSchema>;
export type BatchGroup = z.infer<typeof BatchGroupSchema>;
export type BatchStructured = z.infer<typeof BatchOutputSchema>;
export type BatchDispatch = BatchStructured["dispatch"];

/** Documento a exibir inline (já paginado por max_chars). */
export interface InlineDoc {
  slug: string;
  url: string;
  text: string;
}

/** ---- batch-plan.ts (funções puras, sem I/O) ---- */
export interface BatchPlanApi {
  /** Nome do arquivo sem ".md" (= outputFileName sem a extensão). */
  slugFromFileName(fileName: string): string;
  /** !returnContent ou okCount===0 -> "saved"; okCount<=inlineMaxFiles -> "inline"; senão "subagents". */
  decideDispatch(okCount: number, returnContent: boolean, inlineMaxFiles: number): BatchDispatch;
  /** Agrupa só os itens status "ok" com saved_path, na ordem original, em blocos de filesPerAgent. */
  planGroups(items: BatchItem[], filesPerAgent: number): BatchGroup[];
  /** Texto de content[0] da resposta, conforme result.dispatch. */
  renderBatchText(result: BatchStructured, inlineDocs: InlineDoc[]): string;
}

/** ---- batch.ts (orquestração com I/O) ---- */
export type PipelineResult = {
  text: string;
  total_chars: number;
  next_start_index: number | null;
  source: string;
  url: string;
  document: string;
  title?: string;
};

export interface BatchDeps {
  /** Padrão: runPipeline. */
  run?: (input: ToolInput) => Promise<PipelineResult>;
  /** Padrão: saveConversion com resolveOutputDir(). */
  save?: (document: string, pageUrl: string, mode: Mode) => Promise<string>;
  /** Padrão: BATCH_CONCURRENCY. */
  concurrency?: number;
  /** Padrão: resolveOutputDir(). Só informativo no resultado (output_dir). */
  outputDir?: string;
}

export type HandleBatch = (
  input: import("./schemas/batch-input.js").BatchInput,
  deps?: BatchDeps,
) => Promise<CallToolResult>;
