/**
 * Regras inline do Turndown: texto (escape), strong/em/del, code inline, links,
 * imagens e checkboxes soltos. Também normaliza NBSP -> espaço antes da conversão.
 */
import type TurndownService from "turndown";
import { trimEndSet, trimStartSet } from "../text-util.js";
import type { ConvertContext, RuleRegistrar } from "../types.js";
import { safeImageSrc, safeLinkHref } from "../url-safety.js";

// ------------------------------------------------------------------- escape

/**
 * Escapa texto comum (nunca é chamado pelo Turndown para texto dentro de
 * `code`/`pre`). Decisões:
 * - `*`, `[`, `]`, `` ` ``, `|` e `\` (antes de pontuação ASCII ou no fim) sempre.
 * - `_` só quando pode abrir/fechar ênfase: `snake_case` (alfanumérico dos dois
 *   lados) fica intacto; `_x`, `x_`, `__init__` são escapados.
 * - Início do nó de texto: `#`..`######` seguido de espaço/fim, `>`, `-`/`+`/`*`
 *   seguidos de espaço, `---`/`===` (setext/hr), `1.`/`1)`, cercas `~~~`/```.
 * - `<` só se puder iniciar tag/autolink/comentário (`<a`, `</`, `<!`, `<?`);
 *   `a < b` fica intacto. `&` só se parecer entidade (`&amp;`, `&#38;`).
 * - `~~` (tachado GFM).
 * - NBSP vira espaço normal.
 * Não escapa `$` (preços são comuns demais).
 */
export function escapeMarkdown(text: string): string {
  let s = text.replace(/ /g, " ");
  s = s.replace(/\\(?=[!-/:-@[-`{-~]|$)/g, "\\\\");
  s = s.replace(/\*/g, "\\*");
  s = s.replace(/`/g, "\\`");
  s = s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  s = s.replace(/\|/g, "\\|");
  s = s.replace(/~{2,}/g, (m) => m.replace(/~/g, "\\~"));
  s = s.replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_");
  s = s.replace(/<(?=[A-Za-z/!?])/g, "\\<");
  s = s.replace(/&(?=#?\w+;)/g, "\\&");
  // Início de linha (início do nó de texto).
  s = s.replace(/^(#{1,6})(?=\s|$)/, "\\$1");
  s = s.replace(/^>/, "\\>");
  s = s.replace(/^([-+])(?=\s|$)/, "\\$1");
  s = s.replace(/^(-{2,}|={1,})\s*$/, (m) => "\\" + m);
  s = s.replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
  return s;
}

/**
 * Escape para texto que vai numa linha de heading (`# ...`) fora de tabela: como
 * `escapeMarkdown`, mas sem escapar `|` (que só tem significado em tabelas).
 * O chamador já colapsou as quebras de linha.
 */
export function escapeHeadingText(text: string): string {
  return escapeMarkdown(text).replace(/\\\|/g, "|");
}

// ---------------------------------------------------------------- utilitários

function ancestorNamed(node: Node, names: readonly string[]): boolean {
  let p = node.parentNode;
  while (p) {
    if (names.includes(p.nodeName)) return true;
    p = p.parentNode;
  }
  return false;
}

const HEADINGS = ["H1", "H2", "H3", "H4", "H5", "H6"] as const;

function cleanAttr(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeTitle(title: string): string {
  return title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Destino de link/imagem: %-encode de espaços/controle/`<>\`, parênteses desbalanceados escapados. */
export function formatDestination(url: string): string {
  const s = url.trim().replace(/[\u0000- \u007f<>\\]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  const bad = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") open.push(i);
    else if (s[i] === ")") {
      if (open.length) open.pop();
      else bad.add(i);
    }
  }
  for (const i of open) bad.add(i);
  if (bad.size === 0) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) out += bad.has(i) ? "\\" + s[i] : s[i];
  return out;
}

/** Em texto de link/alt: remove quebras de parágrafo (não pode ter linha em branco). */
function inlineLinkText(content: string): string {
  return content
    .trim()
    .split(/\n{2,}/)
    .map((part) => part.trim().replace(/^#{1,6} /, ""))
    .filter(Boolean)
    .join(" ");
}

// ------------------------------------------------------------------- srcset

interface SrcsetCandidate {
  url: string;
  kind: "w" | "x" | "none";
  value: number;
}

/** Parse de srcset conforme o algoritmo do HTML (URLs podem conter vírgulas). */
export function parseSrcset(srcset: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;
  const n = srcset.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  while (i < n) {
    while (i < n && (isWs(srcset[i]!) || srcset[i] === ",")) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !isWs(srcset[i]!)) i++;
    let url = srcset.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = trimEndSet(url, ",");
    } else {
      while (i < n && isWs(srcset[i]!)) i++;
      start = i;
      let paren = false;
      while (i < n) {
        const c = srcset[i]!;
        if (c === "(") paren = true;
        else if (c === ")") paren = false;
        else if (c === "," && !paren) break;
        i++;
      }
      descriptor = srcset.slice(start, i).trim();
    }
    if (!url) continue;
    const m = /^(\d+(?:\.\d+)?|\.\d+)\s*([wx])$/i.exec(descriptor);
    if (m) out.push({ url, kind: m[2]!.toLowerCase() as "w" | "x", value: parseFloat(m[1]!) });
    else out.push({ url, kind: "none", value: 1 });
  }
  return out;
}

/** URL do candidato de maior resolução (largura `w` se houver, senão densidade `x`). */
export function pickLargestSrcset(srcset: string): string {
  const cands = parseSrcset(srcset);
  if (cands.length === 0) return "";
  const hasW = cands.some((c) => c.kind === "w");
  let best = cands[0]!;
  for (const c of cands) {
    if (hasW && c.kind !== "w") continue;
    if (hasW && best.kind !== "w") {
      best = c;
      continue;
    }
    if (c.value > best.value) best = c;
  }
  return best.url;
}

const MAX_DATA_URI = 1000;

function imageSource(node: HTMLElement): string {
  const attr = (name: string) => (node.getAttribute(name) ?? "").trim();
  const fallbacks = (): string => {
    const set = attr("srcset") || attr("data-srcset");
    if (set) {
      const u = pickLargestSrcset(set);
      if (u) return u;
    }
    for (const name of ["data-src", "data-lazy-src", "data-original"]) {
      if (attr(name)) return attr(name);
    }
    if (node.parentNode?.nodeName === "PICTURE") {
      for (const child of Array.from(node.parentNode.childNodes)) {
        if (child.nodeName === "SOURCE") {
          const el = child as HTMLElement;
          const u = pickLargestSrcset(el.getAttribute("srcset") ?? "");
          if (u) return u;
        }
      }
    }
    return "";
  };
  const src = attr("src");
  if (!src) return fallbacks();
  if (/^data:/i.test(src)) {
    const alt = fallbacks();
    if (alt) return alt;
    return src.length <= MAX_DATA_URI ? src : "";
  }
  return src;
}

// ----------------------------------------------------------------------- NBSP

const NBSP_SKIP = new Set(["PRE", "CODE", "TEXTAREA", "SCRIPT", "STYLE"]);

function normalizeNbsp(node: Node): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) {
      const t = child as Text;
      if (t.data.includes(" ")) t.data = t.data.replace(/ /g, " ");
    } else if (child.nodeType === 1 && !NBSP_SKIP.has(child.nodeName)) {
      normalizeNbsp(child);
    }
  }
}

// ------------------------------------------------------------------ registrar

export const registerInlineRules: RuleRegistrar = (td: TurndownService, ctx: ConvertContext) => {
  td.escape = escapeMarkdown;

  // NBSP fora de code/pre vira espaço normal (antes do colapso de whitespace).
  const originalTurndown = td.turndown.bind(td);
  td.turndown = (input) => {
    if (typeof input !== "string" && input && typeof input.cloneNode === "function") {
      const clone = input.cloneNode(true);
      normalizeNbsp(clone);
      return originalTurndown(clone as TurndownService.Node);
    }
    return originalTurndown(input);
  };

  // ------------------------------------------------------------ ênfase

  const emphasis = (key: string, filter: TurndownService.TagName[], names: string[], delimiter: () => string) => {
    td.addRule(key, {
      filter,
      replacement: (content, node) => {
        if (!content.trim()) return "";
        // Mesma ênfase aninhada não duplica delimitador.
        if (ancestorNamed(node, names)) return content;
        const d = delimiter();
        const trimmed = content.trim();
        const lead = content.slice(0, content.length - content.trimStart().length);
        const trail = content.slice(content.trimEnd().length);
        return lead + d + trimmed + d + trail;
      },
    });
  };
  emphasis("w2m-strong", ["strong", "b"], ["STRONG", "B", "DT"], () => "**");
  emphasis("w2m-em", ["em", "i"], ["EM", "I"], () => "*");
  emphasis("w2m-del", ["del", "s", "strike" as TurndownService.TagName], ["DEL", "S", "STRIKE"], () => "~~");

  // ------------------------------------------------------------ code inline

  td.addRule("w2m-inline-code", {
    filter: (node) => {
      if (node.nodeName !== "CODE") return false;
      const parent = node.parentNode;
      return !(parent && parent.nodeName === "PRE");
    },
    replacement: (_content, node) => {
      const fw = (node as unknown as { flankingWhitespace?: { leading: string; trailing: string } }).flankingWhitespace;
      let text = node.textContent ?? "";
      if (fw && (fw.leading || fw.trailing)) text = trimStartSet(trimEndSet(text, " \t\r\n"), " \t\r\n");
      text = text.replace(/\r?\n|\r/g, " ");
      if (text === "") return "";
      let len = 1;
      const runs = new Set((text.match(/`+/g) ?? []).map((r) => r.length));
      while (runs.has(len)) len++;
      const delim = "`".repeat(len);
      const guard = text.includes("`") || (/^ .* $/.test(text) && text.trim() !== "") ? " " : "";
      return delim + guard + text + guard + delim;
    },
  });

  // ------------------------------------------------------------ links

  const isPermalink = (node: HTMLElement, href: string, text: string): boolean => {
    if (!href.startsWith("#") || !ancestorNamed(node, HEADINGS)) return false;
    if (/^[#¶§\u{1F517}∞¤⚓]+$/u.test(text)) return true;
    return /anchor|permalink|headerlink|heading-link/i.test(node.getAttribute("class") ?? "") && text.length <= 2;
  };

  td.addRule("w2m-link", {
    filter: "a",
    replacement: (content, node) => {
      const text = inlineLinkText(content);
      if (!text) return "";
      const rawHref = (node.getAttribute("href") ?? "").trim();
      if (!rawHref) return text;
      const plain = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (isPermalink(node, rawHref, plain)) return "";

      const url = rawHref.startsWith("#") ? rawHref : ctx.resolveUrl(rawHref);
      // Allowlist de esquemas sobre a URL resolvida (o parser WHATWG já removeu tabs/controles):
      // javascript:, data:, vbscript:, file: etc. perdem o link e ficam só com o texto.
      if (!safeLinkHref(url)) return text;

      // Texto == URL -> autolink.
      if (!node.querySelector("img")) {
        const absolute = /^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i.test(url);
        if (absolute && (plain === url || (plain === rawHref && /^[a-z][a-z0-9+.-]*:/i.test(rawHref)))) return `<${url}>`;
        const mail = /^mailto:([^?\s<>]+)$/i.exec(url);
        if (mail && plain === mail[1] && /^[^@\s]+@[^@\s]+$/.test(plain)) return `<${plain}>`;
      }

      const title = escapeTitle(cleanAttr(node.getAttribute("title")));
      return `[${text}](${formatDestination(url)}${title ? ` "${title}"` : ""})`;
    },
  });

  // ------------------------------------------------------------ imagens

  td.addRule("w2m-image", {
    filter: "img",
    replacement: (_content, node) => {
      const raw = imageSource(node);
      if (!raw) return "";
      const src = safeImageSrc(/^data:/i.test(raw) ? raw : ctx.resolveUrl(raw));
      if (!src) return "";
      const alt = escapeMarkdown(cleanAttr(node.getAttribute("alt")));
      const title = escapeTitle(cleanAttr(node.getAttribute("title")));
      return `![${alt}](${formatDestination(src)}${title ? ` "${title}"` : ""})`;
    },
  });

  // Checkboxes (task list é tratada em li) e inputs soltos não geram texto.
  td.addRule("w2m-input", {
    filter: "input",
    replacement: () => "",
  });
};
