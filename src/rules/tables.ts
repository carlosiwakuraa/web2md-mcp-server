import type TurndownService from "turndown";
import { collapseLineBreaks, isJsWhitespace, trimEndSet } from "../text-util.js";
import type { ConvertContext, RuleRegistrar } from "../types.js";
import { safeImageSrc, safeLinkHref } from "../url-safety.js";
import { mediaInfo } from "./embedded.js";
import { extractMath, formatMath, isMathRoot } from "./math.js";

/**
 * Tabelas.
 *  - Simples  -> tabela GFM (cabeçalho = <thead> ou primeira linha).
 *  - Complexas (colspan/rowspan > 1, blocos em células, tabela aninhada, vários <thead>)
 *    -> HTML embutido limpo (sem class/style/id), indentado, cercado por linhas em branco.
 *  - Tabela de uma única célula (layout) -> o conteúdo da célula, sem tabela.
 *  - <caption> -> parágrafo em negrito antes da tabela GFM (ou <caption> no HTML).
 */

const BLOCK_IN_CELL = "p, ul, ol, pre, table, blockquote, div, h1, h2, h3, h4, h5, h6, dl, hr, figure, details";
const BR_MARK = "";

type Align = "left" | "center" | "right" | null;

function tagOf(el: Element): string {
  return el.nodeName.toLowerCase();
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

function span(el: Element, attr: "colspan" | "rowspan"): number {
  const v = parseInt(el.getAttribute(attr) ?? "1", 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function alignOf(cell: Element): Align {
  const a = (cell.getAttribute("align") ?? "").toLowerCase();
  if (a === "left" || a === "center" || a === "right") return a;
  if (a === "middle") return "center";
  const m = /text-align\s*:\s*(left|center|right)/i.exec(cell.getAttribute("style") ?? "");
  return m ? (m[1]!.toLowerCase() as Align) : null;
}

interface TableModel {
  caption: Element | null;
  /** Linhas por seção, na ordem do documento (tfoot vai para o fim na versão GFM). */
  sections: { kind: "thead" | "tbody" | "tfoot" | "direct"; rows: Element[] }[];
}

function readTable(table: Element): TableModel {
  const model: TableModel = { caption: null, sections: [] };
  for (const child of elementChildren(table)) {
    const tag = tagOf(child);
    if (tag === "caption") model.caption ??= child;
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      model.sections.push({ kind: tag, rows: elementChildren(child).filter((r) => tagOf(r) === "tr") });
    } else if (tag === "tr") {
      const last = model.sections[model.sections.length - 1];
      if (last && last.kind === "direct") last.rows.push(child);
      else model.sections.push({ kind: "direct", rows: [child] });
    }
  }
  return model;
}

function cellsOf(row: Element): Element[] {
  return elementChildren(row).filter((c) => {
    const t = tagOf(c);
    return t === "td" || t === "th";
  });
}

// ---------------------------------------------------------------- células (GFM)

/** Desembrulha `<td><p>x</p></td>` / `<td><div><p>x</p></div></td>`. */
function unwrapSingleBlocks(cell: Element): void {
  for (let guard = 0; guard < 6; guard++) {
    let only: Element | null = null;
    let other = false;
    for (let n = cell.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && !(n.nodeValue ?? "").trim()) continue;
      if (n.nodeType === 8) continue;
      if (n.nodeType === 1 && !only && ["p", "div"].includes(tagOf(n as Element))) only = n as Element;
      else other = true;
    }
    if (!only || other) return;
    while (only.firstChild) cell.insertBefore(only.firstChild, only);
    cell.removeChild(only);
  }
}

function hasBlock(cell: Element): boolean {
  // domino devolve undefined (não null) quando não encontra
  return !!cell.querySelector(BLOCK_IN_CELL);
}

/** Cópia da célula pronta para conversão, ou null se houver blocos que o GFM não suporta. */
function prepareCell(cell: Element): Element | null {
  const clone = cell.cloneNode(true) as Element;
  unwrapSingleBlocks(clone);
  if (hasBlock(clone)) return null;
  const doc = clone.ownerDocument;
  const brs = clone.querySelectorAll("br");
  for (let i = 0; i < brs.length; i++) {
    const br = brs[i]!;
    br.parentNode?.replaceChild(doc.createTextNode(BR_MARK), br);
  }
  return clone;
}

/** `$$\ntex\n$$` -> `$tex$` (linear: cada busca avança, e sem fechamento nada mais casa). */
function displayMathToInline(md: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  for (;;) {
    const open = md.indexOf("$$\n", from);
    if (open === -1) break;
    const close = md.indexOf("\n$$", open + 3);
    if (close === -1) break;
    out += `${md.slice(last, open)}$${collapseLineBreaks(md.slice(open + 3, close))}$`;
    last = close + 3;
    from = last;
  }
  return last === 0 ? md : out + md.slice(last);
}

/** Tira `<br>` (com espaço em volta) do início e do fim. */
function trimBreaks(md: string): string {
  let start = 0;
  while (md.startsWith("<br>", start)) {
    start += 4;
    while (start < md.length && isJsWhitespace(md.charCodeAt(start))) start++;
  }
  let end = md.length;
  for (;;) {
    let k = end;
    while (k > start && isJsWhitespace(md.charCodeAt(k - 1))) k--;
    if (k - 4 >= start && md.startsWith("<br>", k - 4)) end = k - 4;
    else break;
  }
  return md.slice(start, end);
}

/** Escapa `|` não escapado (número par de contrabarras antes): quebraria a tabela. */
function escapePipes(md: string): string {
  if (!md.includes("|")) return md;
  let out = "";
  let backslashes = 0;
  for (const ch of md) {
    if (ch === "|") out += backslashes % 2 === 0 ? "\\|" : "|";
    else out += ch;
    backslashes = ch === "\\" ? backslashes + 1 : 0;
  }
  return out;
}

function inlineMarkdown(td: TurndownService, prepared: Element): string {
  let md = td.turndown(prepared as unknown as HTMLElement);
  md = md.split(BR_MARK).join("<br>");
  // matemática display dentro de célula vira inline
  md = displayMathToInline(md);
  md = collapseLineBreaks(md).trim();
  md = trimBreaks(md).trim();
  return escapePipes(md);
}

// ---------------------------------------------------------------- GFM

function toGfm(td: TurndownService, model: TableModel): string | null {
  const theadRows = model.sections.filter((s) => s.kind === "thead").flatMap((s) => s.rows);
  if (theadRows.length > 1) return null;

  const ordered: Element[] = [
    ...model.sections.filter((s) => s.kind === "thead").flatMap((s) => s.rows),
    ...model.sections.filter((s) => s.kind === "tbody" || s.kind === "direct").flatMap((s) => s.rows),
    ...model.sections.filter((s) => s.kind === "tfoot").flatMap((s) => s.rows),
  ];
  if (ordered.length === 0) return "";

  const grid: string[][] = [];
  const aligns: Align[] = [];
  for (const row of ordered) {
    const cells = cellsOf(row);
    const out: string[] = [];
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]!;
      if (span(cell, "colspan") > 1 || span(cell, "rowspan") > 1) return null;
      const prepared = prepareCell(cell);
      if (!prepared) return null;
      out.push(inlineMarkdown(td, prepared));
      aligns[c] ??= alignOf(cell);
    }
    grid.push(out);
  }

  const width = Math.max(1, ...grid.map((r) => r.length));
  for (const r of grid) while (r.length < width) r.push("");

  const fmt = (r: string[]): string => `| ${r.join(" | ")} |`;
  const delim = Array.from({ length: width }, (_, i) => {
    const a = aligns[i] ?? null;
    return a === "left" ? ":---" : a === "center" ? ":---:" : a === "right" ? "---:" : "---";
  });
  const lines = [fmt(grid[0]!), `| ${delim.join(" | ")} |`, ...grid.slice(1).map(fmt)];

  let caption = "";
  if (model.caption) {
    const prepared = prepareCell(model.caption);
    if (prepared) {
      const cap = inlineMarkdown(td, prepared).replace(/\\\|/g, "|");
      if (cap) caption = cap.includes("**") ? cap : `**${cap}**`;
    }
  }
  return `\n\n${caption ? `${caption}\n\n` : ""}${lines.join("\n")}\n\n`;
}

// ---------------------------------------------------------------- HTML embutido

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Valor de atributo numa única linha (uma quebra viraria linha nova no Markdown, ex.: `# INJETADO`). */
function escAttr(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Início de linha dentro de `<pre>` que viraria heading/cerca no Markdown: usa entidade numérica. */
function escapeLineStarts(text: string): string {
  return text.replace(/^([ \t]*)([#`~])/gm, (_m, ws: string, c: string) => `${ws}&#${c.charCodeAt(0)};`);
}

const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "link", "meta", "button", "select", "textarea", "input", "canvas"]);
const KEEP_SIMPLE: Record<string, string> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  del: "del",
  s: "del",
  strike: "del",
  code: "code",
  kbd: "kbd",
  sup: "sup",
  sub: "sub",
  mark: "mark",
  p: "p",
  ul: "ul",
  li: "li",
  blockquote: "blockquote",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  dl: "dl",
  dt: "dt",
  dd: "dd",
  figure: "figure",
  figcaption: "figcaption",
  summary: "summary",
};
const BLOCKISH = new Set(["div", "section", "article", "header", "footer", "main", "aside", "nav", "address", "center", "fieldset", "form"]);
const LIST_LIKE = new Set(["ul", "ol", "dl"]);

function serializeChildren(parent: Node, ctx: ConvertContext, ignoreBlankText = false): string {
  let out = "";
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      const t = (n.nodeValue ?? "").replace(/\s+/g, " ");
      if (ignoreBlankText && !t.trim()) continue;
      out += escHtml(t);
    } else if (n.nodeType === 1) {
      out += serializeElement(n as Element, ctx);
    }
  }
  return out;
}

function serializeElement(el: Element, ctx: ConvertContext): string {
  const tag = tagOf(el);
  if (SKIP.has(tag)) return "";
  if (isMathRoot(el)) {
    const m = extractMath(el);
    if (m === "ignore") return "";
    if (m) return escHtml(formatMath(m, true));
  }
  if (tag === "br") return "<br>";
  if (tag === "hr") return "<hr>";
  if (tag === "img") {
    const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
    if (!src) return "";
    const safe = safeImageSrc(/^\s*data:/i.test(src) ? src : ctx.resolveUrl(src));
    if (!safe) return "";
    const alt = el.getAttribute("alt") ?? "";
    return `<img src="${escAttr(safe)}" alt="${escAttr(alt)}">`;
  }
  if (tag === "a") {
    const inner = serializeChildren(el, ctx);
    const href = el.getAttribute("href");
    if (!href) return inner;
    // Allowlist de esquemas sobre a URL resolvida; fora dela o link cai e fica o texto.
    const safe = safeLinkHref(ctx.resolveUrl(href));
    if (!safe) return inner;
    if (!inner.trim()) return "";
    const title = el.getAttribute("title");
    return `<a href="${escAttr(safe)}"${title ? ` title="${escAttr(title)}"` : ""}>${inner}</a>`;
  }
  if (tag === "video" || tag === "audio" || tag === "iframe") {
    const info = mediaInfo(el, (raw) => ctx.resolveUrl(raw));
    if (!info) return serializeChildren(el, ctx);
    return `<a href="${escAttr(info.href)}">${escHtml(`${info.label}: ${info.title}`)}</a>`;
  }
  if (tag === "pre") {
    const text = trimEndSet(el.textContent ?? "", "\n");
    // linha em branco encerraria o bloco HTML do CommonMark: usa entidade
    const safe = escapeLineStarts(escHtml(text)).replace(/\n{2,}/g, (m) => `\n${"&#10;".repeat(m.length - 1)}`);
    return `<pre><code>${safe}</code></pre>`;
  }
  if (tag === "ol") {
    const start = el.getAttribute("start");
    const inner = serializeChildren(el, ctx, true);
    return `<ol${start && start !== "1" && /^-?\d+$/.test(start) ? ` start="${start}"` : ""}>${inner}</ol>`;
  }
  if (tag === "details") {
    return `<details${el.hasAttribute("open") ? " open" : ""}>${serializeChildren(el, ctx)}</details>`;
  }
  if (tag === "table") return serializeTable(el, ctx, 0, true);
  const simple = KEEP_SIMPLE[tag];
  if (simple) {
    const inner = serializeChildren(el, ctx, LIST_LIKE.has(tag));
    if (!inner.trim() && simple !== "li") return "";
    return `<${simple}>${inner}</${simple}>`;
  }
  const inner = serializeChildren(el, ctx);
  return BLOCKISH.has(tag) ? `${inner} ` : inner;
}

function cellAttrs(cell: Element): string {
  let attrs = "";
  const cs = span(cell, "colspan");
  const rs = span(cell, "rowspan");
  if (cs > 1) attrs += ` colspan="${cs}"`;
  if (rs > 1) attrs += ` rowspan="${rs}"`;
  const a = alignOf(cell);
  if (a) attrs += ` align="${a}"`;
  return attrs;
}

function serializeTable(table: Element, ctx: ConvertContext, depth: number, compact: boolean): string {
  const model = readTable(table);
  const nl = compact ? "" : "\n";
  const ind = (level: number): string => (compact ? "" : "  ".repeat(depth + level));
  const lines: string[] = [`${ind(0)}<table>`];

  if (model.caption) {
    const cap = serializeChildren(model.caption, ctx).trim();
    if (cap) lines.push(`${ind(1)}<caption>${cap}</caption>`);
  }
  const emitRows = (rows: Element[], level: number): void => {
    for (const row of rows) {
      lines.push(`${ind(level)}<tr>`);
      for (const cell of cellsOf(row)) {
        const t = tagOf(cell);
        lines.push(`${ind(level + 1)}<${t}${cellAttrs(cell)}>${serializeChildren(cell, ctx).trim()}</${t}>`);
      }
      lines.push(`${ind(level)}</tr>`);
    }
  };
  for (const s of model.sections) {
    if (s.kind === "direct") {
      emitRows(s.rows, 1);
    } else {
      lines.push(`${ind(1)}<${s.kind}>`);
      emitRows(s.rows, 2);
      lines.push(`${ind(1)}</${s.kind}>`);
    }
  }
  lines.push(`${ind(0)}</table>`);
  return lines.join(nl);
}

// ---------------------------------------------------------------- regra

export const registerTableRules: RuleRegistrar = (td: TurndownService, ctx) => {
  td.addRule("web2md-table", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as unknown as Element;
      const model = readTable(table);
      const allRows = model.sections.flatMap((s) => s.rows);
      if (allRows.length === 0 && !model.caption) return "";

      // Tabela de layout com uma única célula: devolve só o conteúdo.
      if (allRows.length === 1) {
        const cells = cellsOf(allRows[0]!);
        if (cells.length === 1) {
          const body = td.turndown(cells[0]!.cloneNode(true) as unknown as HTMLElement).trim();
          return body ? `\n\n${body}\n\n` : "";
        }
      }

      const gfm = toGfm(td, model);
      if (gfm !== null) return gfm;

      return `\n\n${serializeTable(table, ctx, 0, false)}\n\n`;
    },
  });
};
