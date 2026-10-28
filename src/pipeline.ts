import { fetchPage } from "./stages/fetch.js";
import {
  matchFragment,
  renderOutline,
  resolveSection,
  shiftHeadings,
  sliceSection,
  subtree,
  type HeadingInfo,
} from "./stages/outline.js";
import { firstH1, paginate, renderDocument } from "./stages/postprocess.js";
import type { FetchOptions, Frontmatter, Mode, PageSlice, ToolInput, ToolMode } from "./types.js";
import { conversionErrors } from "./worker/conversion-errors.js";
import { convertHtmlInWorker, postProcessInWorker, type ConvertInWorkerOptions } from "./worker/client.js";

// A conversão pesada vive em worker/convert-core.ts (roda num worker_thread em runPipeline); estas
// reexportações mantêm a API síncrona usada pelos testes golden e por quem importava de "pipeline".
export { convertHtml, makeConvertContext, type ConvertHtmlOptions } from "./worker/convert-core.js";

/** Heading/seção como vai no structuredContent (offsets no documento completo, com frontmatter). */
export interface OutlineEntry {
  heading: string;
  level: number;
  slug: string;
  id: string | null;
  start: number;
  end: number;
  chars: number;
}

export type PipelineResult = PageSlice & {
  source: string;
  url: string;
  /** Documento completo (frontmatter + corpo): o que é salvo em disco, qualquer que seja section/outline. */
  document: string;
  document_chars: number;
  title?: string;
  /** Seção devolvida (parâmetro section ou fragmento da URL), ou null. */
  section: OutlineEntry | null;
  /** Lista de headings no modo outline (limitada a MAX_STRUCTURED_HEADINGS), ou null. */
  headings: OutlineEntry[] | null;
  /** true se `headings` foi cortada em MAX_STRUCTURED_HEADINGS (há mais headings do que os listados). */
  headings_truncated: boolean;
};

/**
 * Teto de headings no structuredContent. Vários clientes repassam o structuredContent ao modelo; em
 * changelogs/referências de API com milhares de headings a lista (~130 bytes por item) anularia o
 * propósito do modo outline. O texto já é limitado por max_chars; este teto limita o dado estruturado.
 */
export const MAX_STRUCTURED_HEADINGS = 500;

/** Menor orçamento de corpo (após o frontmatter) para ainda mantermos o frontmatter no outline truncado. */
const MIN_OUTLINE_BODY_CHARS = 250;

/** Modo de conversão efetivo: "outline" converte como "article" (e compartilha o arquivo salvo dele). */
export function conversionMode(mode: ToolMode): Mode {
  return mode === "outline" ? "article" : mode;
}

/** Fragmento (`#x`) da URL, sem o `#`, ou undefined. */
export function urlFragment(url: string): string | undefined {
  const i = url.indexOf("#");
  if (i === -1) return undefined;
  const frag = url.slice(i + 1);
  return frag === "" ? undefined : frag;
}

function toEntry(h: HeadingInfo): OutlineEntry {
  return { heading: h.text, level: h.level, slug: h.slug, id: h.id, start: h.start, end: h.end, chars: h.chars };
}

/** ISO 8601 com o offset local (ex.: 2026-10-20T22:32:00-03:00), nunca `Z`. */
export function formatLocalIso(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Opções de execução (não de rede): cancelamento e, nos testes, pool/limites alternativos. */
export type RunOptions = ConvertInWorkerOptions;

/** Pipeline completo: fetch -> convert (em worker_thread) -> frontmatter -> paginação. */
export async function runPipeline(
  input: ToolInput,
  fetchOpts?: FetchOptions,
  runOpts: RunOptions = {},
): Promise<PipelineResult> {
  const fetched = await fetchPage(input.url, fetchOpts);
  if (runOpts.signal?.aborted) throw conversionErrors.aborted();

  // Seção: `section` é estrito (erro se não casar); o fragmento da URL é leniente (ignorado se não casar,
  // e não vale no modo outline, que quer o índice inteiro). Os headings são listados no worker.
  const outline = input.mode === "outline";
  const wantHeadings = outline || input.section !== undefined || input.fragment !== undefined;

  let fm: Frontmatter;
  let body: string;
  let headings: HeadingInfo[] = [];

  if (fetched.kind === "native-markdown") {
    const out = await postProcessInWorker(fetched.markdown, wantHeadings, runOpts);
    body = out.body;
    headings = out.headings ?? [];
    fm = {
      url: fetched.finalUrl,
      title: firstH1(body),
      fetched_at: formatLocalIso(),
      source: "native-markdown",
    };
  } else {
    const out = await convertHtmlInWorker(
      {
        html: fetched.html,
        pageUrl: fetched.finalUrl,
        mode: conversionMode(input.mode),
        includeLinks: input.include_links,
        wantHeadings,
      },
      runOpts,
    );
    const page = out.page!;
    body = out.body;
    headings = out.headings ?? [];
    fm = {
      url: page.meta.url,
      canonical: page.meta.canonical,
      title: page.meta.title,
      description: page.meta.description,
      lang: page.meta.lang,
      fetched_at: formatLocalIso(),
      source: "html",
    };
  }

  const document = renderDocument(fm, body);
  const common = { source: fm.source, url: fm.url, document, document_chars: document.length, title: fm.title };

  let target: HeadingInfo | undefined;
  if (wantHeadings) {
    if (input.section !== undefined) target = resolveSection(headings, input.section);
    else if (!outline && input.fragment !== undefined) target = matchFragment(headings, input.fragment);
  }
  // Offsets públicos são do documento completo: o corpo vem depois do frontmatter.
  const base = document.length - body.length;
  const sectionFm = target ? { section: target.text, section_slug: target.slug } : {};

  if (outline) {
    const listed = shiftHeadings(target ? subtree(headings, target) : headings, base);
    const outlineFm = { ...fm, mode: "outline" as const, ...sectionFm };
    // O índice não é paginado (start_index não se aplica), mas max_chars limita o TEXTO inteiro (frontmatter
    // + índice + aviso): se não couber, renderOutline mostra só os primeiros itens que cabem.
    const fmChars = renderDocument(outlineFm, "").length;
    let text = renderDocument(outlineFm, renderOutline(listed, document.length, fm.title));
    if (text.length > input.max_chars) {
      // Com max_chars minúsculo o frontmatter sozinho pode estourar: nesse caso ele é descartado.
      const keepFm = input.max_chars - fmChars >= MIN_OUTLINE_BODY_CHARS;
      const body = renderOutline(
        listed,
        document.length,
        fm.title,
        keepFm ? input.max_chars - fmChars : input.max_chars,
      );
      text = keepFm ? renderDocument(outlineFm, body) : body;
    }
    // total_chars é o do documento completo.
    const headingsTruncated = listed.length > MAX_STRUCTURED_HEADINGS;
    return {
      ...common,
      text,
      total_chars: document.length,
      next_start_index: null,
      section: target ? toEntry(shiftHeadings([target], base)[0]!) : null,
      headings: listed.slice(0, MAX_STRUCTURED_HEADINGS).map(toEntry),
      headings_truncated: headingsTruncated,
    };
  }

  if (target) {
    const sectionDoc = renderDocument({ ...fm, ...sectionFm }, sliceSection(body, target));
    const slice = paginate(sectionDoc, input.start_index, input.max_chars);
    return { ...common, ...slice, section: toEntry(shiftHeadings([target], base)[0]!), headings: null, headings_truncated: false };
  }

  const slice = paginate(document, input.start_index, input.max_chars);
  return { ...common, ...slice, section: null, headings: null, headings_truncated: false };
}
