/** Tipos compartilhados da tool de lote (v1.2). */
import type * as z from "zod/v4";
import type { PipelineResult as FullPipelineResult } from "./pipeline.js";
import type { BatchGroupSchema, BatchItemSchema, BatchOutputSchema } from "./schemas/batch-input.js";
import type { Mode, ToolInput } from "./types.js";

export type BatchItem = z.infer<typeof BatchItemSchema>;
export type BatchGroup = z.infer<typeof BatchGroupSchema>;
export type BatchStructured = z.infer<typeof BatchOutputSchema>;
export type BatchDispatch = BatchStructured["dispatch"];

/** Documento a exibir inline. */
export interface InlineDoc {
  slug: string;
  url: string;
  /** Corpo já truncado em max_chars (não confiável: vai dentro do envelope). */
  text: string;
  /** Marcador de truncamento do servidor (vai fora do envelope), ou null. */
  marker: string | null;
}

export type PipelineResult = FullPipelineResult;

export interface BatchDeps {
  /** Padrão: runPipeline com timeout limitado ao tempo restante do prazo do lote. */
  run?: (input: ToolInput) => Promise<PipelineResult>;
  /** Padrão: saveConversion gravando em `outputDir`. */
  save?: (document: string, pageUrl: string, mode: Mode) => Promise<string>;
  /** Padrão: BATCH_CONCURRENCY. */
  concurrency?: number;
  /** Padrão: resolveOutputDir(). Pasta onde o `save` padrão grava; é também o `output_dir` informado no resultado. */
  outputDir?: string;
  /** Padrão: BATCH_DEADLINE_MS. Prazo global do lote, em milissegundos. */
  deadlineMs?: number;
}
