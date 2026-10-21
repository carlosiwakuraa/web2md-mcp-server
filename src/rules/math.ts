import type TurndownService from "turndown";
import type { RuleRegistrar } from "../types.js";

/**
 * Matemática: MathML, KaTeX, MathJax v2/v3 e Wikipedia (mwe-math) -> `$tex$` / `$$\ntex\n$$`.
 * O conteúdo TeX nunca é escapado. Prioridade da fonte do TeX:
 * <annotation encoding="application/x-tex"> > data-latex > MathML convertido > alttext/aria-label > texto.
 */

export interface MathInfo {
  tex: string;
  display: boolean;
}

/** "ignore" = lixo duplicado (descartar); undefined = não é matemática (comportamento padrão). */
export type MathResult = MathInfo | "ignore" | undefined;

const MATHJAX_V2_RENDERED = new Set([
  "mathjax",
  "mathjax_display",
  "mathjax_svg",
  "mathjax_svg_display",
  "mathjax_chtml",
  "mathjax_chtml_display",
  "mathjax_mathml",
  "mathjax_mathml_display",
  "mathjax_nativemathml",
]);

function classTokens(el: Element): string[] {
  const raw = el.getAttribute("class");
  return raw ? raw.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

function hasClass(el: Element, name: string): boolean {
  return classTokens(el).includes(name);
}

function tagOf(el: Element): string {
  return el.nodeName.toLowerCase();
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

function hasAncestor(el: Element, test: (a: Element) => boolean): boolean {
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    if (test(p as Element)) return true;
  }
  return false;
}

/** Filtro barato: este elemento é a raiz de algum tipo de matemática? */
export function isMathRoot(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === "math" || tag === "mjx-container") return true;
  if (tag === "script") return (el.getAttribute("type") ?? "").toLowerCase().startsWith("math/");
  const raw = el.getAttribute("class");
  if (!raw) return false;
  const tokens = raw.toLowerCase().split(/\s+/);
  return tokens.some(
    (t) =>
      t === "katex" ||
      t === "katex-display" ||
      t === "katex-html" ||
      t === "katex-mathml" ||
      t === "mathjax_preview" ||
      t === "mwe-math-element" ||
      MATHJAX_V2_RENDERED.has(t),
  );
}

// ---------------------------------------------------------------- MathML -> TeX (simples)

function texEscapeChar(s: string): string {
  return s.replace(/[{}#%&_$]/g, (c) => `\\${c}`);
}

function group(s: string): string {
  return s.length === 1 ? s : `{${s}}`;
}

function localName(el: Element): string {
  const n = el.nodeName.toLowerCase();
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
}

function mmlChildren(el: Element): string {
  let out = "";
  for (let n = el.firstChild; n; n = n.nextSibling) out += mmlNode(n);
  return out;
}

function mmlNode(n: Node): string {
  if (n.nodeType === 3) return (n.nodeValue ?? "").replace(/\s+/g, " ");
  if (n.nodeType !== 1) return "";
  const el = n as Element;
  const kids = elementChildren(el);
  const k = (i: number): string => (kids[i] ? mmlNode(kids[i]) : "");
  switch (localName(el)) {
    case "annotation":
    case "annotation-xml":
      return "";
    case "semantics":
      return k(0);
    case "mi":
    case "mn": {
      const t = (el.textContent ?? "").trim();
      if (localName(el) === "mi" && t.length > 1 && /^[A-Za-z]+$/.test(t)) return `\\mathrm{${t}}`;
      return texEscapeChar(t);
    }
    case "mo": {
      const t = (el.textContent ?? "").trim();
      if (t === "−") return "-";
      return texEscapeChar(t);
    }
    case "mtext":
      return `\\text{${(el.textContent ?? "").replace(/\s+/g, " ").replace(/[{}\\]/g, (c) => `\\${c}`)}}`;
    case "mspace":
      return "\\ ";
    case "msup":
      return `${group(k(0))}^${group(k(1))}`;
    case "msub":
      return `${group(k(0))}_${group(k(1))}`;
    case "msubsup":
      return `${group(k(0))}_${group(k(1))}^${group(k(2))}`;
    case "munderover":
      return `${group(k(0))}_${group(k(1))}^${group(k(2))}`;
    case "mover":
      return `\\overset{${k(1)}}{${k(0)}}`;
    case "munder":
      return `\\underset{${k(1)}}{${k(0)}}`;
    case "mfrac":
      return `\\frac{${k(0)}}{${k(1)}}`;
    case "msqrt":
      return `\\sqrt{${mmlChildren(el)}}`;
    case "mroot":
      return `\\sqrt[${k(1)}]{${k(0)}}`;
    case "mfenced": {
      const open = el.getAttribute("open") ?? "(";
      const close = el.getAttribute("close") ?? ")";
      const sep = (el.getAttribute("separators") ?? ",").charAt(0) || ",";
      return `${open}${kids.map((c) => mmlNode(c)).join(sep)}${close}`;
    }
    case "mtable":
      return `\\begin{matrix} ${kids.map((r) => mmlNode(r)).join(" \\\\ ")} \\end{matrix}`;
    case "mtr":
    case "mlabeledtr":
      return kids.map((c) => mmlNode(c)).join(" & ");
    default:
      return mmlChildren(el);
  }
}

/** Conversão best-effort de MathML sem anotação TeX. Devolve "" se nada útil sai. */
function mathmlToTex(math: Element): string {
  return mmlChildren(math).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- extração

function annotationTex(root: Element): string | null {
  const list = root.querySelectorAll("annotation");
  for (let i = 0; i < list.length; i++) {
    const enc = (list[i]!.getAttribute("encoding") ?? "").toLowerCase();
    if (/tex/.test(enc)) {
      const t = (list[i]!.textContent ?? "").trim();
      if (t) return t;
    }
  }
  return null;
}

function cleanTex(raw: string, display: boolean): string {
  let tex = raw.trim();
  // Wikipedia: {\displaystyle E=mc^{2}}
  const m = /^\{\\(?:displaystyle|textstyle|scriptstyle)\s+/.exec(tex);
  if (m && tex.endsWith("}")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < tex.length; i++) {
      const c = tex[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0 && i < tex.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (wraps) tex = tex.slice(m[0].length, -1).trim();
  }
  if (!display) tex = tex.replace(/\s*\n\s*/g, " ");
  return tex;
}

function firstMath(root: Element): Element | null {
  return tagOf(root) === "math" ? root : root.querySelector("math");
}

function texFromContainer(el: Element): string | null {
  const ann = annotationTex(el);
  if (ann) return ann;
  const latexAttr = el.getAttribute("data-latex") ?? el.getAttribute("data-tex");
  if (latexAttr && latexAttr.trim()) return latexAttr.trim();
  const inner = el.querySelector("[data-latex]");
  if (inner && (inner.getAttribute("data-latex") ?? "").trim()) return inner.getAttribute("data-latex")!.trim();
  const math = firstMath(el);
  if (math) {
    const t = mathmlToTex(math);
    if (t) return t;
    const alt = (math.getAttribute("alttext") ?? "").trim();
    if (alt) return alt;
  }
  const aria = (el.getAttribute("aria-label") ?? "").trim();
  if (aria) return aria;
  // Wikipedia: <img class="mwe-math-fallback-image-*" alt="{\displaystyle ...}">
  const img = el.querySelector("img");
  const alt = img ? (img.getAttribute("alt") ?? "").trim() : "";
  if (alt) return alt;
  return null;
}

function isDisplayContext(el: Element): boolean {
  const own = (el.getAttribute("display") ?? "").toLowerCase();
  if (own === "block" || own === "true") return true;
  const math = tagOf(el) === "math" ? null : el.querySelector("math");
  if (math && (math.getAttribute("display") ?? "").toLowerCase() === "block") return true;
  return hasAncestor(
    el,
    (a) =>
      hasClass(a, "katex-display") ||
      hasClass(a, "mwe-math-mathml-display") ||
      (tagOf(a) === "mjx-container" && (a.getAttribute("display") ?? "").toLowerCase() === "true"),
  );
}

function nextScriptTex(el: Element): Element | null {
  let sib = el.nextSibling;
  let hops = 0;
  while (sib && hops < 4) {
    if (sib.nodeType === 1) {
      const e = sib as Element;
      if (tagOf(e) === "script" && (e.getAttribute("type") ?? "").toLowerCase().startsWith("math/tex")) return e;
      hops++;
    }
    sib = sib.nextSibling;
  }
  return null;
}

function prevHasClass(el: Element, name: string): boolean {
  let sib = el.previousSibling;
  while (sib && sib.nodeType !== 1) sib = sib.previousSibling;
  return !!sib && hasClass(sib as Element, name);
}

/**
 * Interpreta um elemento como matemática. Não recursivo: a regra do Turndown
 * substitui o elemento inteiro, então descendentes (ex.: `.katex-html`) nunca são visitados.
 */
export function extractMath(el: Element): MathResult {
  const tag = tagOf(el);

  if (tag === "script") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (!type.startsWith("math/tex")) return type.startsWith("math/") ? "ignore" : undefined;
    const tex = cleanTex(el.textContent ?? "", true);
    if (!tex) return "ignore";
    return { tex, display: /mode\s*=\s*display/.test(type) };
  }

  if (hasClass(el, "katex-html")) return "ignore";

  // MathJax v2: preview e saída renderizada duplicam o <script type="math/tex">.
  if (hasClass(el, "mathjax_preview")) return nextScriptTex(el) ? "ignore" : undefined;
  if (classTokens(el).some((t) => MATHJAX_V2_RENDERED.has(t)) && tag !== "mjx-container") {
    if (nextScriptTex(el) || prevHasClass(el, "mathjax_preview")) return "ignore";
    if (el.querySelector("math")) {
      /* segue: tratado como contêiner abaixo */
    } else {
      return undefined;
    }
  }

  const isContainer =
    tag === "math" ||
    tag === "mjx-container" ||
    hasClass(el, "katex") ||
    hasClass(el, "katex-display") ||
    hasClass(el, "katex-mathml") ||
    hasClass(el, "mwe-math-element") ||
    classTokens(el).some((t) => MATHJAX_V2_RENDERED.has(t));
  if (!isContainer) return undefined;

  const display = hasClass(el, "katex-display") || isDisplayContext(el);
  let raw = texFromContainer(el);
  if (raw === null) {
    // Sem nada melhor: texto visível, ignorando a cópia visual do KaTeX.
    const mathEl = firstMath(el);
    raw = ((mathEl ?? el).textContent ?? "").trim();
  }
  const tex = cleanTex(raw, display);
  if (!tex) return "ignore";
  return { tex, display };
}

export function formatMath(info: MathInfo, forceInline = false): string {
  if (info.display && !forceInline) return `\n\n$$\n${info.tex}\n$$\n\n`;
  return `$${info.tex.replace(/\s*\n\s*/g, " ")}$`;
}

// ---------------------------------------------------------------- registro

export const registerMathRules: RuleRegistrar = (td: TurndownService, _ctx) => {
  td.addRule("web2md-math", {
    filter: (node) => node.nodeType === 1 && isMathRoot(node as unknown as Element),
    replacement: (content, node) => {
      const res = extractMath(node as unknown as Element);
      if (res === undefined) return content;
      if (res === "ignore") return "";
      return formatMath(res);
    },
  });

  // Turndown decide "blank" antes das regras: um mjx-container só com SVG pareceria vazio.
  // Embrulha o blankRule para não descartar matemática que tem TeX em atributos.
  const rules = (td as unknown as { rules?: { blankRule?: { replacement: (c: string, n: Node, o: unknown) => string } } }).rules;
  const blank = rules?.blankRule;
  if (blank && typeof blank.replacement === "function") {
    const original = blank.replacement;
    blank.replacement = (content, node, options) => {
      if (node.nodeType === 1 && isMathRoot(node as unknown as Element)) {
        const res = extractMath(node as unknown as Element);
        if (res && res !== "ignore") return formatMath(res);
      }
      return original(content, node, options);
    };
  }
};
