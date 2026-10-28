import type { HeadingInfo } from "../stages/outline.js";
import type { ConvertedPage, Mode } from "../types.js";

/** Trabalho enviado ao worker de conversão. */
export type ConvertRequest =
  | {
      kind: "html";
      html: string;
      pageUrl: string;
      mode: Mode;
      includeLinks: boolean;
      /** Também lista os headings do corpo (parseHeadings), para outline/section/fragmento. */
      wantHeadings: boolean;
      limits: { maxNodes: number; maxDepth: number };
    }
  | { kind: "markdown"; markdown: string; wantHeadings: boolean };

export interface ConvertOutput {
  /** Presente só em kind "html". */
  page: ConvertedPage | null;
  /** Corpo Markdown pós-processado (sem frontmatter). */
  body: string;
  headings: HeadingInfo[] | null;
}

/** Erro serializável de dentro do worker (instâncias de Error não atravessam o postMessage com a classe). */
export type WorkerErrorPayload =
  | { type: "web2md"; code: string; message: string }
  | { type: "stack-overflow" }
  | { type: "internal"; detail: string };

export type WorkerResponse<R> = { ok: true; result: R } | { ok: false; error: WorkerErrorPayload };
