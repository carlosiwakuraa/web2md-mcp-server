/**
 * Regras de bloco do Turndown: títulos (com âncoras de id), blocos de código,
 * listas (inclui task list), blockquote, hr, br e listas de definição.
 */
import type TurndownService from "turndown";
import type { RuleRegistrar } from "../types.js";

// ---------------------------------------------------------------- utilitários

/** Mesma lista de blocos do Turndown (nomes em maiúsculas). */
const BLOCK_NAMES = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "AUDIO", "BLOCKQUOTE", "BODY", "CANVAS", "CENTER", "DD", "DIR", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "FRAMESET", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
  "HGROUP", "HR", "HTML", "ISINDEX", "LI", "MAIN", "MENU", "NAV", "NOFRAMES", "NOSCRIPT", "OL", "OUTPUT", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const MEANINGFUL_SELECTOR = "img,input,iframe,video,audio,svg,object,embed,picture,math,hr,table,a[href]";

function trimNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

function hasContent(el: Element): boolean {
  if (/\S/.test(el.textContent ?? "")) return true;
  if (/^(IMG|INPUT|IFRAME|VIDEO|AUDIO|SVG|OBJECT|EMBED|PICTURE|MATH|HR|TABLE)$/i.test(el.nodeName)) return true;
  return el.querySelector(MEANINGFUL_SELECTOR) !== null;
}

function ancestorIs(node: Node, pred: (el: Element) => boolean): boolean {
  let p = node.parentNode;
  while (p) {
    if (p.nodeType === 1 && pred(p as Element)) return true;
    p = p.parentNode;
  }
  return false;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ------------------------------------------------------------------- headings

function emptyNamedAnchor(n: Node): Element | null {
  if (n.nodeType !== 1 || n.nodeName !== "A") return null;
  const el = n as Element;
  if (hasContent(el)) return null;
  return el.getAttribute("id") || el.getAttribute("name") ? el : null;
}

function headingIds(node: Element): string[] {
  const ids: string[] = [];
  const add = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    if (t && !ids.includes(t)) ids.push(t);
  };
  // `<a name="x"></a><h2>` imediatamente antes do título.
  const before: Element[] = [];
  for (let p = node.previousSibling; p; p = p.previousSibling) {
    if (p.nodeType === 3 && !/\S/.test((p as Text).data)) continue;
    const a = emptyNamedAnchor(p);
    if (!a) break;
    before.unshift(a);
  }
  for (const a of before) {
    add(a.getAttribute("id"));
    add(a.getAttribute("name"));
  }
  add(node.getAttribute("id"));
  for (const el of Array.from(node.querySelectorAll("[id], a[name]"))) {
    add(el.getAttribute("id"));
    if (el.nodeName === "A") add(el.getAttribute("name"));
  }
  return ids;
}

// ---------------------------------------------------------------------- pre

const LINE_NUMBER_CLASS = /^(?:line-?numbers?|linenos?|linenumber|line-numbers-rows|hljs-ln-numbers|hljs-ln-n|react-syntax-highlighter-line-number)$/i;
const LINE_CLASS = /^(?:line|token-line|code-line)$/i;
const LANG_TOKEN = /^[\w#+.-]+$/;

function classTokens(el: Element | null | undefined): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function langFromElement(el: Element | null | undefined): string {
  if (!el) return "";
  for (const t of classTokens(el)) {
    const m = /^(?:language|lang)-(.+)$/i.exec(t);
    if (m && LANG_TOKEN.test(m[1]!)) return m[1]!;
  }
  for (const name of ["data-lang", "data-language"]) {
    const v = (el.getAttribute(name) ?? "").trim();
    if (v && LANG_TOKEN.test(v)) return v;
  }
  return "";
}

function detectLanguage(pre: Element): string {
  const first = pre.firstElementChild;
  const code = first && first.nodeName === "CODE" ? first : pre.querySelector("code");
  const parent = pre.parentElement;
  const wrapper = parent && /^(DIV|FIGURE|SPAN|SECTION)$/.test(parent.nodeName) ? parent : null;
  let lang = langFromElement(code) || langFromElement(pre) || langFromElement(wrapper);
  if (!lang && wrapper) {
    for (const el of [wrapper, wrapper.parentElement]) {
      for (const t of classTokens(el)) {
        const m = /^highlight-source-(.+)$/i.exec(t);
        if (m && LANG_TOKEN.test(m[1]!)) {
          lang = m[1]!;
          break;
        }
      }
      if (lang) break;
    }
  }
  return /^(none|plain)$/i.test(lang) ? "" : lang;
}

/** Texto literal de um `pre`: `<br>` vira \n, spans de highlight são achatados, números de linha ignorados. */
function collectPreText(node: Node, out: { s: string }): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      out.s += (child as Text).data;
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    if (el.nodeName === "BR") {
      out.s += "\n";
      continue;
    }
    if (el.nodeName === "SCRIPT" || el.nodeName === "STYLE") continue;
    const tokens = classTokens(el);
    if (tokens.some((t) => LINE_NUMBER_CLASS.test(t)) || el.hasAttribute("data-line-number")) continue;
    collectPreText(el, out);
    // Linhas em spans `.line` sem \n entre elas: insere a quebra.
    const parentName = el.parentNode?.nodeName;
    if ((parentName === "PRE" || parentName === "CODE") && tokens.some((t) => LINE_CLASS.test(t))) {
      const next = el.nextSibling;
      const nextIsNewline = next && next.nodeType === 3 && /^\r?\n/.test((next as Text).data);
      if (next && !out.s.endsWith("\n") && !nextIsNewline) out.s += "\n";
    }
  }
}

// --------------------------------------------------------------------- listas

const looseCache = new WeakMap<Element, boolean>();

function isLooseList(list: Element): boolean {
  const cached = looseCache.get(list);
  if (cached !== undefined) return cached;
  let loose = false;
  for (const li of Array.from(list.children)) {
    if (li.nodeName !== "LI") continue;
    let blocks = 0;
    for (const c of Array.from(li.children)) {
      if (c.nodeName === "P") {
        loose = true;
        break;
      }
      if (BLOCK_NAMES.has(c.nodeName) && c.nodeName !== "UL" && c.nodeName !== "OL") blocks++;
    }
    if (loose || blocks >= 2) {
      loose = true;
      break;
    }
  }
  looseCache.set(list, loose);
  return loose;
}

function isBlankLi(li: Element): boolean {
  return !hasContent(li);
}

function listNumber(list: Element, li: Element): number {
  const items = Array.from(list.children).filter((c) => c.nodeName === "LI" && !isBlankLi(c));
  const reversed = list.hasAttribute("reversed");
  const startAttr = parseInt(list.getAttribute("start") ?? "", 10);
  let cur = Number.isFinite(startAttr) ? startAttr : reversed ? items.length : 1;
  for (const item of items) {
    const v = parseInt(item.getAttribute("value") ?? "", 10);
    if (Number.isFinite(v)) cur = v;
    if (item === li) return cur;
    cur += reversed ? -1 : 1;
  }
  return cur;
}

function findCheckbox(li: Element): HTMLInputElement | null {
  for (const input of Array.from(li.querySelectorAll("input"))) {
    if ((input.getAttribute("type") ?? "").toLowerCase() !== "checkbox") continue;
    let p: Node | null = input.parentNode;
    while (p && p.nodeName !== "LI") p = p.parentNode;
    if (p === li) return input as HTMLInputElement;
  }
  return null;
}

// --------------------------------------------------------------------- br

/** `<br>` sem conteúdo útil depois (dir=next) ou antes (dir=prev) dentro do bloco. */
function atBlockEdge(node: Node, dir: "next" | "prev"): boolean {
  let n: Node = node;
  for (;;) {
    let sib: Node | null = dir === "next" ? n.nextSibling : n.previousSibling;
    while (sib) {
      if (sib.nodeType === 3) {
        if (/\S/.test((sib as Text).data)) return false;
      } else if (sib.nodeType === 1) {
        const el = sib as Element;
        if (el.nodeName !== "BR") {
          if (BLOCK_NAMES.has(el.nodeName)) return true;
          if (hasContent(el)) return false;
        }
      }
      sib = dir === "next" ? sib.nextSibling : sib.previousSibling;
    }
    const parent: Node | null = n.parentNode;
    if (!parent || BLOCK_NAMES.has(parent.nodeName)) return true;
    n = parent;
  }
}

// ------------------------------------------------------------------ registrar

export const registerBlockRules: RuleRegistrar = (td: TurndownService) => {
  // `li` vazio some em vez de virar linha em branco (que tornaria a lista "solta").
  const blankRule = td.rules.blankRule as unknown as { replacement: TurndownService.ReplacementFunction };
  const originalBlank = blankRule.replacement;
  blankRule.replacement = (content, node, options) =>
    node.nodeName === "LI" ? "" : originalBlank(content, node, options);

  // ------------------------------------------------------------ headings

  td.addRule("w2m-heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1));
      const ids = headingIds(node);
      const anchors = ids.map((id) => `<a id="${escapeAttr(id)}"></a>`).join("");
      let text = content.replace(/\s*\n\s*/g, " ").trim();
      text = text.replace(/ (#+)$/, " \\$1");
      if (!text) return anchors ? `\n\n${anchors}\n\n` : "";
      return `\n\n${anchors ? anchors + "\n" : ""}${"#".repeat(level)} ${text}\n\n`;
    },
  });

  // ------------------------------------------------------------ pre

  td.addRule("w2m-pre", {
    filter: "pre",
    replacement: (_content, node) => {
      // Coluna de números de linha (Pygments `td.linenos`, `.linenodiv`) não é código.
      if (ancestorIs(node, (el) => classTokens(el).some((t) => /^(linenos|linenodiv)$/i.test(t)))) return "";
      const out = { s: "" };
      collectPreText(node, out);
      const code = out.s.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      if (!/\S/.test(code)) return "";
      const runs = code.match(/`+/g) ?? [];
      const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `\n\n${fence}${detectLanguage(node)}\n${code}\n${fence}\n\n`;
    },
  });

  // ------------------------------------------------------------ listas

  td.addRule("w2m-list", {
    filter: ["ul", "ol"],
    replacement: (content, node) => {
      const body = trimNewlines(content);
      const parent = node.parentNode as Element | null;
      if (parent && parent.nodeName === "LI" && parent.lastElementChild === node) return "\n" + body;
      return "\n\n" + body + "\n\n";
    },
  });

  td.addRule("w2m-list-item", {
    filter: "li",
    replacement: (content, node) => {
      const parent = node.parentNode as Element | null;
      const marker = parent && parent.nodeName === "OL" ? `${listNumber(parent, node)}. ` : "- ";
      const checkbox = findCheckbox(node);
      const task = checkbox ? (checkbox.checked || checkbox.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
      const body = trimNewlines(content).replace(/^[ \t]+/, "");
      if (!body && !task) return "";
      const indent = " ".repeat(marker.length);
      const indented = body
        .split("\n")
        .map((line, i) => (i === 0 || line === "" ? line : indent + line))
        .join("\n");
      const loose = parent ? isLooseList(parent) : false;
      return (marker + task + indented).trimEnd() + (loose ? "\n\n" : "\n");
    },
  });

  // ------------------------------------------------------------ blockquote

  td.addRule("w2m-blockquote", {
    filter: "blockquote",
    replacement: (content) => {
      const body = trimNewlines(content);
      if (!body) return "";
      const quoted = body
        .split("\n")
        .map((line) => (line.trim() === "" ? ">" : "> " + line))
        .join("\n");
      return `\n\n${quoted}\n\n`;
    },
  });

  // ------------------------------------------------------------ hr / br

  td.addRule("w2m-hr", {
    filter: "hr",
    replacement: () => "\n\n---\n\n",
  });

  td.addRule("w2m-br", {
    filter: "br",
    replacement: (_content, node) => {
      if (ancestorIs(node, (el) => HEADINGS.has(el.nodeName))) return " ";
      if (ancestorIs(node, (el) => el.nodeName === "PRE")) return "\n";
      if (atBlockEdge(node, "next") || atBlockEdge(node, "prev")) return "";
      return "\\\n";
    },
  });

  // ------------------------------------------------------------ dl/dt/dd

  td.addRule("w2m-dl", {
    filter: "dl",
    replacement: (content) => {
      const body = trimNewlines(content);
      return body ? `\n\n${body}\n\n` : "";
    },
  });

  td.addRule("w2m-dt", {
    filter: "dt",
    replacement: (content, node) => {
      const text = content.replace(/\s*\n\s*/g, " ").trim();
      if (!text) return "";
      const prev = node.previousElementSibling;
      const lead = prev && prev.nodeName === "DT" ? "\n" : "\n\n";
      return `${lead}**${text}**\n`;
    },
  });

  td.addRule("w2m-dd", {
    filter: "dd",
    replacement: (content) => {
      const body = trimNewlines(content).replace(/^[ \t]+/, "");
      return body ? `\n${body}\n\n` : "";
    },
  });
};
