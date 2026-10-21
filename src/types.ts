/**
 * CONTRATOS entre os estágios do pipeline web2md.
 * Cada estágio é implementado em paralelo por um agente diferente;
 * mudar uma assinatura aqui exige coordenação. Não edite sem necessidade.
 */
import type TurndownService from "turndown";

export type Mode = "article" | "full";

/** Entrada já validada da tool (ver schemas/input.ts). */
export interface ToolInput {
  url: string;
  mode: Mode;
  max_chars: number;
  start_index: number;
  include_links: boolean;
}

// ---------------------------------------------------------------- etapas 1-2

export interface FetchOptions {
  /** Padrão: FETCH_TIMEOUT_MS (30 s). */
  timeoutMs?: number;
  /** Injetável para testes. Padrão: globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type FetchResult =
  | {
      kind: "native-markdown";
      /** URL final, depois de redirects. */
      finalUrl: string;
      markdown: string;
    }
  | {
      kind: "html";
      finalUrl: string;
      /** HTML já decodificado (header charset > <meta charset> > chardet). */
      html: string;
    };

// ---------------------------------------------------------------- etapas 3-4

export interface PageMeta {
  /** URL final (depois de redirects). */
  url: string;
  canonical?: string;
  title?: string;
  description?: string;
  lang?: string;
  /** Base para resolver URLs relativas: <base href> resolvido contra `url`, senão `url`. */
  baseUrl: string;
}

export type ExtractStrategy = "main" | "article" | "role-main" | "readability" | "body";

export interface ExtractResult {
  root: Element;
  strategy: ExtractStrategy;
}

// ------------------------------------------------------------------ etapa 5

export interface LinkRecord {
  text: string;
  href: string;
}

export interface ConvertContext {
  /** Base absoluta para resolver URLs relativas. */
  baseUrl: string;
  /** Resolve href/src relativo para absoluto. Devolve o original se inválido. */
  resolveUrl(raw: string): string;
}

/** Cada arquivo em rules/ exporta uma função com esta assinatura. */
export type RuleRegistrar = (td: TurndownService, ctx: ConvertContext) => void;

// ---------------------------------------------------------------- etapa 6 / saída

export type Source = "html" | "native-markdown";

export interface Frontmatter {
  url: string;
  canonical?: string;
  title?: string;
  description?: string;
  lang?: string;
  /** ISO 8601 com offset local, ex.: 2026-10-20T22:32:00-03:00 */
  fetched_at: string;
  source: Source;
}

/** Resultado da conversão, ainda sem paginação. `body` começa com o H1. */
export interface ConvertedPage {
  meta: PageMeta;
  body: string;
  links: LinkRecord[];
  source: Source;
}

export interface PageSlice {
  /** Texto a devolver ao Claude (já com marcador de continuação se truncado). */
  text: string;
  total_chars: number;
  /** null quando não há mais conteúdo. */
  next_start_index: number | null;
}
