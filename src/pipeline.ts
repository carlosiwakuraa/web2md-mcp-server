import { cleanDom } from "./stages/clean.js";
import { convertToMarkdown } from "./stages/convert.js";
import { assertUsableContent, countScripts, extractMain, extractMeta, parseHtml } from "./stages/extract.js";
import { fetchPage } from "./stages/fetch.js";
import {
  matchFragment,
  parseHeadings,
  renderOutline,
  resolveSection,
  shiftHeadings,
  sliceSection,
  subtree,
  type HeadingInfo,
} from "./stages/outline.js";
import {
  collectLinks,
  ensureSingleH1,
  firstH1,
  paginate,
  postProcess,
  renderDocument,
  renderLinksSection,
} from "./stages/postprocess.js";
import type {
  ConvertContext,
  ConvertedPage,
  FetchOptions,
  Frontmatter,
  Mode,
  PageSlice,
  ToolInput,
  ToolMode,
} from "./types.js";

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
  /** Lista de headings no modo outline, ou null. */
  headings: OutlineEntry[] | null;
};

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

export interface ConvertHtmlOptions {
  mode: Mode;
  includeLinks: boolean;
}

/** Contexto de conversão: resolve URLs relativas contra `baseUrl`; fragmentos (`#x`) ficam como estão. */
export function makeConvertContext(baseUrl: string): ConvertContext {
  return {
    baseUrl,
    resolveUrl(raw: string): string {
      const value = raw.trim();
      if (value === "" || value.startsWith("#")) return raw;
      try {
        return new URL(value, baseUrl).href;
      } catch {
        return raw;
      }
    },
  };
}

/**
 * HTML -> corpo Markdown (sem frontmatter, sem paginação; com a seção de links
 * se `includeLinks`). Usado também pelos golden tests.
 */
export function convertHtml(html: string, pageUrl: string, opts: ConvertHtmlOptions): ConvertedPage {
  const doc = parseHtml(html, pageUrl);
  const meta = extractMeta(doc, pageUrl);
  const scriptCount = countScripts(doc);

  cleanDom(doc);
  const ctx = makeConvertContext(meta.baseUrl);
  // "Todos os links da página": coletados do body inteiro, antes de a extração remover nav/footer.
  const links = opts.includeLinks ? collectLinks(doc.body, ctx.resolveUrl) : [];
  const { root } = extractMain(doc, opts.mode);
  assertUsableContent(doc, root, opts.mode, meta.url, scriptCount);

  let md = ensureSingleH1(convertToMarkdown(root, ctx), meta.title);
  if (links.length > 0) {
    md = `${md.trimEnd()}\n\n${renderLinksSection(links)}`;
  }
  return { meta, body: postProcess(md), links, source: "html" };
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

/** Pipeline completo: fetch -> convert -> frontmatter -> paginação. */
export async function runPipeline(
  input: ToolInput,
  fetchOpts?: FetchOptions,
): Promise<PipelineResult> {
  const fetched = await fetchPage(input.url, fetchOpts);

  let fm: Frontmatter;
  let body: string;

  if (fetched.kind === "native-markdown") {
    body = postProcess(fetched.markdown);
    fm = {
      url: fetched.finalUrl,
      title: firstH1(body),
      fetched_at: formatLocalIso(),
      source: "native-markdown",
    };
  } else {
    const page = convertHtml(fetched.html, fetched.finalUrl, {
      mode: conversionMode(input.mode),
      includeLinks: input.include_links,
    });
    body = page.body;
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
  const outline = input.mode === "outline";

  // Seção: `section` é estrito (erro se não casar); o fragmento da URL é leniente (ignorado se não casar,
  // e não vale no modo outline, que quer o índice inteiro).
  let headings: HeadingInfo[] = [];
  let target: HeadingInfo | undefined;
  if (outline || input.section !== undefined || input.fragment !== undefined) {
    headings = parseHeadings(body);
    if (input.section !== undefined) target = resolveSection(headings, input.section);
    else if (!outline && input.fragment !== undefined) target = matchFragment(headings, input.fragment);
  }
  // Offsets públicos são do documento completo: o corpo vem depois do frontmatter.
  const base = document.length - body.length;
  const sectionFm = target ? { section: target.text, section_slug: target.slug } : {};

  if (outline) {
    const listed = shiftHeadings(target ? subtree(headings, target) : headings, base);
    const text = renderDocument(
      { ...fm, mode: "outline", ...sectionFm },
      renderOutline(listed, document.length, fm.title),
    );
    // O índice não é paginado: max_chars/start_index não se aplicam; total_chars é o do documento completo.
    return {
      ...common,
      text,
      total_chars: document.length,
      next_start_index: null,
      section: target ? toEntry(shiftHeadings([target], base)[0]!) : null,
      headings: listed.map(toEntry),
    };
  }

  if (target) {
    const sectionDoc = renderDocument({ ...fm, ...sectionFm }, sliceSection(body, target));
    const slice = paginate(sectionDoc, input.start_index, input.max_chars);
    return { ...common, ...slice, section: toEntry(shiftHeadings([target], base)[0]!), headings: null };
  }

  const slice = paginate(document, input.start_index, input.max_chars);
  return { ...common, ...slice, section: null, headings: null };
}
