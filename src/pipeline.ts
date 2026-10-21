import { cleanDom } from "./stages/clean.js";
import { convertToMarkdown } from "./stages/convert.js";
import { assertUsableContent, countScripts, extractMain, extractMeta, parseHtml } from "./stages/extract.js";
import { fetchPage } from "./stages/fetch.js";
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
} from "./types.js";

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
): Promise<PageSlice & { source: string; url: string; document: string }> {
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
      mode: input.mode,
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
  const slice = paginate(document, input.start_index, input.max_chars);
  return { ...slice, source: fm.source, url: fm.url, document };
}
