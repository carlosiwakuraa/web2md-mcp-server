import {
  MAX_DOM_DEPTH,
  MAX_DOM_NODES,
  MAX_HTML_BYTES_ENV,
  MAX_HTML_BYTES_FOR_CONVERSION,
  PRESCAN_DEPTH_FACTOR,
} from "../constants.js";
import { effectiveEnv } from "../env.js";
import { conversionErrors } from "./conversion-errors.js";

export interface ConversionLimits {
  maxHtmlBytes: number;
  maxNodes: number;
  maxDepth: number;
}

/** Limites efetivos: padrões das constantes, WEB2MD_MAX_HTML_BYTES (lida a cada chamada) e `overrides` (testes). */
export function resolveLimits(overrides: Partial<ConversionLimits> = {}): ConversionLimits {
  const raw = effectiveEnv(process.env[MAX_HTML_BYTES_ENV]);
  const parsed = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const fromEnv = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : MAX_HTML_BYTES_FOR_CONVERSION;
  return {
    maxHtmlBytes: overrides.maxHtmlBytes ?? fromEnv,
    maxNodes: overrides.maxNodes ?? MAX_DOM_NODES,
    maxDepth: overrides.maxDepth ?? MAX_DOM_DEPTH,
  };
}

// Elementos que não abrem nível de aninhamento (void) ou que o parser fecha sozinho: não contam na
// profundidade da pré-checagem (evita falso positivo em HTML sem </p>, </li>, </td>...).
const NO_DEPTH = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
  "param", "keygen", "basefont", "bgsound", "frame",
  "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption",
  "option", "optgroup", "rt", "rp", "html", "head", "body",
]);

// Conteúdo "texto cru": o que está dentro não é marcação.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes", "plaintext"]);

const TAG_SOURCE = "<(!--|/?([a-zA-Z][^\\s/>]*))";

/**
 * Pré-checagem BARATA (um scan linear por regex, sem parse): rejeita HTML com elementos demais ou
 * aninhamento absurdo antes de entregá-lo ao jsdom. A profundidade aqui é aproximada, então o corte só
 * vale acima de maxDepth x PRESCAN_DEPTH_FACTOR; o corte exato é feito depois do parse (assertDomWithinLimits).
 */
export function prescanHtml(html: string, limits: Pick<ConversionLimits, "maxNodes" | "maxDepth">): void {
  const depthCap = limits.maxDepth * PRESCAN_DEPTH_FACTOR;
  const re = new RegExp(TAG_SOURCE, "g");
  let elements = 0;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === "!--") {
      const end = html.indexOf("-->", m.index + 4);
      if (end === -1) break;
      re.lastIndex = end + 3;
      continue;
    }
    const closing = m[1]!.charCodeAt(0) === 47; // "/"
    const name = m[2]!.toLowerCase();
    if (closing) {
      if (!NO_DEPTH.has(name) && depth > 0) depth--;
      continue;
    }
    if (++elements > limits.maxNodes) throw conversionErrors.tooManyNodes(limits.maxNodes);
    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}[\\s/>]`, "ig");
      close.lastIndex = re.lastIndex;
      const c = close.exec(html);
      if (!c) break;
      re.lastIndex = c.index; // o fechamento é processado normalmente
      continue;
    }
    if (!NO_DEPTH.has(name) && ++depth > depthCap) throw conversionErrors.tooDeep(limits.maxDepth);
  }
}

/** Checagem do tamanho (barata) + pré-scan. Roda na thread principal, antes de enfileirar a conversão. */
export function assertHtmlWithinLimits(html: string, limits: ConversionLimits): void {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > limits.maxHtmlBytes) {
    throw conversionErrors.htmlTooLarge(bytes, limits.maxHtmlBytes, MAX_HTML_BYTES_ENV);
  }
  prescanHtml(html, limits);
}

/** Checagem exata pós-parse: contagem de elementos e profundidade, por travessia iterativa (sem recursão). */
export function assertDomWithinLimits(doc: Document, limits: Pick<ConversionLimits, "maxNodes" | "maxDepth">): void {
  const root = doc.documentElement;
  if (!root) return;
  let nodes = 0;
  let depth = 1;
  let node: Node = root;
  for (;;) {
    if (node.nodeType === 1 && ++nodes > limits.maxNodes) throw conversionErrors.tooManyNodes(limits.maxNodes);
    if (depth > limits.maxDepth) throw conversionErrors.tooDeep(limits.maxDepth);
    if (node.firstChild) {
      node = node.firstChild;
      depth++;
      continue;
    }
    for (;;) {
      if (node === root) return;
      if (node.nextSibling) {
        node = node.nextSibling;
        break;
      }
      node = node.parentNode as Node;
      depth--;
    }
  }
}
