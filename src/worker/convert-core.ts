/**
 * Parte CPU-bound da conversão (parse jsdom + Readability + clean + convert + postprocess + parseHeadings).
 * Roda dentro do worker (convert-worker.ts); `convertHtml` também é usado direto (síncrono) pelos testes golden.
 */
import { cleanDom } from "../stages/clean.js";
import { convertToMarkdown } from "../stages/convert.js";
import { assertUsableContent, countScripts, extractMain, extractMeta, parseHtml } from "../stages/extract.js";
import { parseHeadings } from "../stages/outline.js";
import { collectLinks, ensureSingleH1, postProcess, renderLinksSection } from "../stages/postprocess.js";
import type { ConvertContext, ConvertedPage, Mode } from "../types.js";
import { assertDomWithinLimits, type ConversionLimits } from "./guards.js";
import type { ConvertOutput, ConvertRequest } from "./protocol.js";

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
 * se `includeLinks`). Com `limits`, aborta (Web2mdError) se o DOM parseado passar de nós/profundidade.
 */
export function convertHtml(
  html: string,
  pageUrl: string,
  opts: ConvertHtmlOptions,
  limits?: Pick<ConversionLimits, "maxNodes" | "maxDepth">,
): ConvertedPage {
  const doc = parseHtml(html, pageUrl);
  if (limits) assertDomWithinLimits(doc, limits);
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

/** Executa uma requisição do pool (no worker). */
export function runConvertRequest(req: ConvertRequest): ConvertOutput {
  if (req.kind === "markdown") {
    const body = postProcess(req.markdown);
    return { page: null, body, headings: req.wantHeadings ? parseHeadings(body) : null };
  }
  const page = convertHtml(
    req.html,
    req.pageUrl,
    { mode: req.mode, includeLinks: req.includeLinks },
    { maxNodes: req.limits.maxNodes, maxDepth: req.limits.maxDepth },
  );
  return { page, body: page.body, headings: req.wantHeadings ? parseHeadings(page.body) : null };
}
