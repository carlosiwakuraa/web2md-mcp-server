import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { errors } from "../errors.js";
import { JS_MIN_SCRIPTS, JS_MIN_TEXT_CHARS } from "../constants.js";
import type { ExtractResult, Mode, PageMeta } from "../types.js";

/** Abaixo disto, <main>/<article> é considerado "pouco texto" e a cadeia continua. */
const MIN_CANDIDATE_CHARS = 100;

/** Avisos de conteúdo: nunca removidos por removeChrome (a conversão os transforma em `> [!NOTE]`). */
const NOTICE_SELECTOR = [
  "aside.note",
  "aside.callout",
  "aside.admonition",
  "aside.tip",
  "aside.warning",
  "aside.caution",
  "aside.important",
  "aside.danger",
  "aside[role='note']",
  ".admonition",
  ".callout",
  "[role='note']",
].join(",");

// ------------------------------------------------------------------ parse

/** Parseia HTML com jsdom SEM executar scripts nem carregar recursos. */
export function parseHtml(html: string, url: string): Document {
  // VirtualConsole sem sendTo: silencia erros de CSS etc. (stdout/stderr são do protocolo MCP).
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, contentType: "text/html", virtualConsole });
  return dom.window.document;
}

// ------------------------------------------------------------------- meta

function attr(doc: Document, selector: string, name: string): string | undefined {
  const v = doc.querySelector(selector)?.getAttribute(name)?.replace(/\s+/g, " ").trim();
  return v ? v : undefined;
}

function resolveOrUndefined(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, base).href;
  } catch {
    return undefined;
  }
}

/** Lê title/description/lang/canonical/<base href>. Chamar ANTES de cleanDom. */
export function extractMeta(doc: Document, finalUrl: string): PageMeta {
  const titleText = doc.querySelector("head > title, title")?.textContent?.replace(/\s+/g, " ").trim();
  const title = titleText || attr(doc, 'meta[property="og:title" i]', "content");

  const description =
    attr(doc, 'meta[name="description" i]', "content") ??
    attr(doc, 'meta[property="og:description" i]', "content");

  const lang = doc.documentElement?.getAttribute("lang")?.trim() || undefined;

  const canonical = resolveOrUndefined(attr(doc, 'link[rel~="canonical" i]', "href"), finalUrl);
  const baseUrl = resolveOrUndefined(attr(doc, "base[href]", "href"), finalUrl) ?? finalUrl;

  const meta: PageMeta = { url: finalUrl, baseUrl };
  if (canonical) meta.canonical = canonical;
  if (title) meta.title = title;
  if (description) meta.description = description;
  if (lang) meta.lang = lang;
  return meta;
}

// -------------------------------------------------------------- utilidades

function textLength(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

const MEDIA_SELECTOR = "img, picture, video, audio, iframe, math";

/** Conta `<script>` do documento. Chamar ANTES de cleanDom (que os remove). */
export function countScripts(doc: Document): number {
  return doc.querySelectorAll("script").length;
}

/** Candidato de maior texto entre os que casam com `selector` dentro de `doc`. */
function largest(doc: Document, selector: string): Element | null {
  let best: Element | null = null;
  let bestLen = -1;
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    const len = textLength(el);
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

/**
 * Remove nav/header/footer/aside de dentro de `root`, preservando:
 *  - avisos de conteúdo (NOTICE_SELECTOR) e o que está dentro deles;
 *  - elementos dentro de blockquote/figure/table (não são chrome de página);
 *  - `header` com título (h1–h6) dentro de article/section (cabeçalho do artigo).
 */
function removeChrome(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("nav, header, footer, aside"))) {
    if (!root.contains(el)) continue; // removido junto com um ancestral
    if (el.closest(NOTICE_SELECTOR)) continue;
    const inner = el.parentElement?.closest("blockquote, figure, table");
    if (inner && root.contains(inner)) continue;
    if (el.tagName === "HEADER" && el.querySelector("h1, h2, h3, h4, h5, h6") && !el.querySelector("nav")) {
      const scope = el.parentElement?.closest("article, section");
      if (scope && root.contains(scope)) continue;
      if (root.tagName === "ARTICLE") continue;
    }
    el.remove();
  }
}

function tryReadability(doc: Document): Element | null {
  try {
    const clone = doc.cloneNode(true) as Document;
    const parsed = new Readability(clone, { keepClasses: true, charThreshold: MIN_CANDIDATE_CHARS }).parse();
    if (!parsed?.content) return null;
    const container = doc.createElement("div");
    container.innerHTML = parsed.content;
    return textLength(container) > 0 ? container : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- extract

/** Etapa 4. mode=full devolve <body>; mode=article usa main > article > [role=main] > Readability. */
export function extractMain(doc: Document, mode: Mode): ExtractResult {
  if (mode === "full") return { root: doc.body, strategy: "body" };

  const chain = [
    { selector: "main", strategy: "main" },
    { selector: "article", strategy: "article" },
    { selector: "[role='main']", strategy: "role-main" },
  ] as const;

  let weak: { el: Element; strategy: (typeof chain)[number]["strategy"] } | null = null;
  for (const { selector, strategy } of chain) {
    const el = largest(doc, selector);
    if (!el) continue;
    removeChrome(el);
    const len = textLength(el);
    if (len >= MIN_CANDIDATE_CHARS) return { root: el, strategy };
    if (!weak || len > textLength(weak.el)) weak = { el, strategy };
  }

  const weakLen = weak ? textLength(weak.el) : 0;

  const readable = tryReadability(doc);
  if (readable) {
    removeChrome(readable);
    const len = textLength(readable);
    if (len >= MIN_CANDIDATE_CHARS && len > weakLen) return { root: readable, strategy: "readability" };
  }

  // Readability falhou (ou não melhorou): melhor entre o candidato fraco e o body.
  if (weak) {
    removeChrome(doc.body);
    // Landmark semântico curto ainda vence o body se carrega parte relevante do texto.
    if (textLength(doc.body) > weakLen && weakLen * 4 < textLength(doc.body)) return { root: doc.body, strategy: "body" };
    return { root: weak.el, strategy: weak.strategy };
  }
  removeChrome(doc.body);
  return { root: doc.body, strategy: "body" };
}

// ------------------------------------------------------------------ assert

/**
 * Lança Web2mdError EMPTY_CONTENT ou JS_REQUIRED quando o conteúdo é inutilizável.
 *
 * `scriptCount`: número de `<script>` do documento ORIGINAL (use `countScripts(doc)` antes de
 * `cleanDom`). Se omitido, conta os `<script>` ainda presentes em `doc`.
 */
export function assertUsableContent(
  doc: Document,
  root: Element,
  mode: Mode,
  url: string,
  scriptCount?: number,
): void {
  const rootLen = textLength(root);
  const hasMedia = root.querySelector(MEDIA_SELECTOR) !== null;
  if (rootLen >= JS_MIN_TEXT_CHARS) return;

  // mode=article com extração minúscula, mas o body inteiro tem muito mais texto:
  // o problema é a extração, não JS — sugerir mode="full".
  if (mode === "article" && root !== doc.body) {
    const bodyLen = doc.body ? textLength(doc.body) : 0;
    if (bodyLen >= JS_MIN_TEXT_CHARS && bodyLen >= rootLen * 3) throw errors.emptyContent("article");
  }

  const scripts = scriptCount ?? countScripts(doc);
  if (scripts >= JS_MIN_SCRIPTS) throw errors.jsRequired(url);

  if (rootLen === 0 && !hasMedia) throw errors.emptyContent(mode);
}
