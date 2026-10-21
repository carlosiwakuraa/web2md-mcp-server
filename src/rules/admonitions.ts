import type TurndownService from "turndown";
import type { RuleRegistrar } from "../types.js";

/**
 * Avisos/admonitions -> alertas do GitHub:
 *   > [!NOTE]
 *   > corpo...
 *
 * Detecção por classe/role; categoria por classe primeiro, depois pelo título.
 *
 * Implementação: o filtro do Turndown roda ANTES de os filhos serem convertidos, então é
 * ali (uma vez por nó, resultado em cache) que o elemento de título é removido do DOM.
 * Assim o corpo convertido (`content`) já chega sem o título e nada é convertido duas vezes.
 */

export type AlertKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

const KIND_BY_WORD: Record<string, AlertKind> = {
  note: "NOTE",
  info: "NOTE",
  information: "NOTE",
  primary: "NOTE",
  secondary: "NOTE",
  seealso: "NOTE",
  "see-also": "NOTE",
  abstract: "NOTE",
  summary: "NOTE",
  todo: "NOTE",
  example: "NOTE",
  question: "NOTE",
  tip: "TIP",
  hint: "TIP",
  success: "TIP",
  check: "TIP",
  done: "TIP",
  important: "IMPORTANT",
  warning: "WARNING",
  warn: "WARNING",
  attention: "WARNING",
  caution: "CAUTION",
  danger: "CAUTION",
  error: "CAUTION",
  critical: "CAUTION",
  failure: "CAUTION",
  fail: "CAUTION",
  bug: "CAUTION",
};

/** Palavras de título (normalizadas, sem acento) -> categoria. */
const KIND_BY_TITLE: Record<string, AlertKind> = {
  note: "NOTE",
  notes: "NOTE",
  nota: "NOTE",
  notas: "NOTE",
  observacao: "NOTE",
  observation: "NOTE",
  info: "NOTE",
  information: "NOTE",
  informacao: "NOTE",
  informacoes: "NOTE",
  tip: "TIP",
  "pro tip": "TIP",
  hint: "TIP",
  dica: "TIP",
  sugestao: "TIP",
  success: "TIP",
  sucesso: "TIP",
  important: "IMPORTANT",
  importante: "IMPORTANT",
  warning: "WARNING",
  aviso: "WARNING",
  atencao: "WARNING",
  attention: "WARNING",
  advertencia: "WARNING",
  caution: "CAUTION",
  cuidado: "CAUTION",
  danger: "CAUTION",
  perigo: "CAUTION",
  error: "CAUTION",
  erro: "CAUTION",
  critical: "CAUTION",
  critico: "CAUTION",
};

/** Palavras ambíguas demais para valer como classe solta: só com prefixo (alert-success...). */
const STRONG_ONLY = new Set([
  "primary",
  "secondary",
  "seealso",
  "see-also",
  "abstract",
  "summary",
  "todo",
  "example",
  "question",
  "success",
  "check",
  "done",
  "failure",
  "fail",
  "bug",
]);

const ALLOWED_TAGS = new Set(["aside", "div", "section", "p", "blockquote", "details", "article"]);
/** Classes sozinhas (sem marcador de admonition) só valem para trechos curtos. */
const BARE_CLASS_MAX_CHARS = 3000;
const PREFIXES = [
  "theme-admonition",
  "markdown-alert",
  "admonition-type",
  "admonition",
  "bs-callout",
  "callout",
  "notecard",
  "alert",
  "message",
  "msg",
  "box",
  "panel",
];
const WEAK_PREFIXES = ["is", "type", "variant", "kind", "level"];
const MARKER_TOKENS = new Set(["admonition", "callout", "markdown-alert", "notecard", "theme-admonition", "ghd-alert"]);

interface Analysis {
  kind: AlertKind;
  /** Título customizado (já em texto simples), quando não é redundante. */
  title: string | null;
}

const analyses = new WeakMap<Element, Analysis | null>();

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function tokensOf(el: Element): string[] {
  const raw = el.getAttribute("class");
  if (!raw) return [];
  return raw
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[-_]+/g, "-"));
}

/** Procura por (prefixo-)*palavra e informa se havia um prefixo de contêiner. */
function kindFromToken(token: string): { kind: AlertKind; strong: boolean } | null {
  const direct = KIND_BY_WORD[token];
  if (direct && !STRONG_ONLY.has(token)) return { kind: direct, strong: false };
  for (const p of PREFIXES) {
    if (token.startsWith(`${p}-`)) {
      const rest = token.slice(p.length + 1);
      const k = KIND_BY_WORD[rest];
      if (k) return { kind: k, strong: true };
      // admonition-type-warning etc.
      for (const q of PREFIXES) {
        if (rest.startsWith(`${q}-`) && KIND_BY_WORD[rest.slice(q.length + 1)]) {
          return { kind: KIND_BY_WORD[rest.slice(q.length + 1)]!, strong: true };
        }
      }
    }
  }
  for (const p of WEAK_PREFIXES) {
    if (token.startsWith(`${p}-`)) {
      const k = KIND_BY_WORD[token.slice(p.length + 1)];
      if (k) return { kind: k, strong: false };
    }
  }
  return null;
}

function isMarkerToken(t: string): boolean {
  return MARKER_TOKENS.has(t);
}

function hasMeaningfulText(n: Node): boolean {
  return (n.textContent ?? "").trim().length > 0;
}

function titleWordKind(text: string): AlertKind | null {
  const t = norm(text).replace(/[\s:.\-–—!]+$/g, "").trim();
  return KIND_BY_TITLE[t] ?? null;
}

function isTitleElement(el: Element): boolean {
  if (el.nodeName.toLowerCase() === "summary") return true;
  return tokensOf(el).some((t) => /(^|-)(title|heading|header|caption)(-|$)/.test(t) || /^(admonition|callout|notecard)(title|heading|header)/.test(t));
}

/** Primeiro elemento filho "de verdade" (pula ícones/vazios). */
function findClassTitle(el: Element): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && (n.nodeValue ?? "").trim()) return null;
    if (n.nodeType !== 1) continue;
    const c = n as Element;
    if (!hasMeaningfulText(c)) continue; // ícone/svg/espaçador
    return isTitleElement(c) ? c : null;
  }
  return null;
}

/** `<strong>Note:</strong>` no início (possivelmente dentro do primeiro p/div). */
function findLeadingStrong(el: Element): Element | null {
  let cur: Element = el;
  for (let depth = 0; depth < 3; depth++) {
    let first: Node | null = cur.firstChild;
    while (first && ((first.nodeType === 3 && !(first.nodeValue ?? "").trim()) || first.nodeType === 8)) first = first.nextSibling;
    if (!first || first.nodeType !== 1) return null;
    const f = first as Element;
    const tag = f.nodeName.toLowerCase();
    if (tag === "strong" || tag === "b") return f;
    if (tag === "p" || tag === "div" || tag === "span") {
      cur = f;
      continue;
    }
    return null;
  }
  return null;
}

function removeLeadingSeparator(after: Node | null): void {
  if (after && after.nodeType === 3) {
    after.nodeValue = (after.nodeValue ?? "").replace(/^\s*[:\-–—]\s*/, "");
  }
}

function analyze(el: Element): Analysis | null {
  const cached = analyses.get(el);
  if (cached !== undefined) return cached;
  const result = compute(el);
  analyses.set(el, result);
  return result;
}

function compute(el: Element): Analysis | null {
  const tag = el.nodeName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return null;

  const tokens = tokensOf(el);
  let marker = tokens.some(isMarkerToken) || (el.getAttribute("role") ?? "").toLowerCase() === "note";
  let classKind: AlertKind | null = null;
  let bareKind: AlertKind | null = null;

  const dataCallout = el.getAttribute("data-callout");
  if (dataCallout) {
    marker = true;
    classKind = KIND_BY_WORD[dataCallout.toLowerCase()] ?? null;
  }
  for (const t of tokens) {
    const k = kindFromToken(t);
    if (!k) continue;
    if (k.strong) {
      marker = true;
      classKind ??= k.kind;
    } else {
      bareKind ??= k.kind;
    }
  }
  // "alert" sozinho não é aviso (banners): exige um tipo. "admonition_xxx" (CSS modules) é marcador.
  if (!marker && tokens.some((t) => /^admonition-[a-z0-9]{4,}$/.test(t) && !/(title|heading|content|icon|body)/.test(t))) marker = true;

  if (!marker) {
    if (!bareKind) return null;
    if ((el.textContent ?? "").length > BARE_CLASS_MAX_CHARS) return null;
  }
  classKind ??= bareKind;
  if (tag === "details" && !marker && !bareKind) return null;

  // ---- título
  let titleEl: Element | null = null;
  let titleText = "";
  let strongCase = false;
  if (tag === "details") {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.nodeName.toLowerCase() === "summary") {
        titleEl = n as Element;
        break;
      }
    }
  } else {
    titleEl = findClassTitle(el);
  }
  if (!titleEl) {
    const s = findLeadingStrong(el);
    if (s && titleWordKind(s.textContent ?? "")) {
      titleEl = s;
      strongCase = true;
    }
  }
  if (titleEl) titleText = collapse(titleEl.textContent ?? "");
  if (titleText.length > 120) {
    // longo demais para ser título: deixa no corpo
    titleEl = null;
    titleText = "";
  }

  const titleKind = titleText ? titleWordKind(titleText) : null;
  const kind: AlertKind = classKind ?? titleKind ?? "NOTE";
  const redundant = titleKind !== null && titleKind === kind;

  let title: string | null = null;
  if (titleEl && titleText) {
    if (strongCase) {
      if (redundant) {
        const next = titleEl.nextSibling;
        titleEl.parentNode?.removeChild(titleEl);
        removeLeadingSeparator(next);
      }
    } else {
      titleEl.parentNode?.removeChild(titleEl);
      if (!redundant) title = titleText;
    }
  } else if (titleEl && !titleText) {
    titleEl.parentNode?.removeChild(titleEl);
  }

  return { kind, title };
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((l) => (l.trim().length ? `> ${l}` : ">"))
    .join("\n");
}

export const registerAdmonitionRules: RuleRegistrar = (td: TurndownService, _ctx) => {
  td.addRule("web2md-admonition", {
    filter: (node) => {
      if (node.nodeType !== 1) return false;
      const tag = node.nodeName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return false;
      return analyze(node as unknown as Element) !== null;
    },
    replacement: (content, node) => {
      const info = analyze(node as unknown as Element);
      if (!info) return content;
      let body = content.trim();
      if (info.title) {
        const t = `**${td.escape(info.title)}**`;
        body = body ? `${t}\n\n${body}` : t;
      }
      if (!body) return ""; // aviso vazio: descartado
      return `\n\n> [!${info.kind}]\n${quote(body)}\n\n`;
    },
  });
};
