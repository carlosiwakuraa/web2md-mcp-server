import { errors } from "../errors.js";
import type { Frontmatter, LinkRecord, PageSlice } from "../types.js";

// ---------------------------------------------------------------- utilitários

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Estado de uma cerca de código (``` ou ~~~) enquanto percorremos as linhas.
 * Devolve o novo estado depois de consumir `line`.
 */
interface FenceState {
  char: string;
  len: number;
}

function nextFenceState(line: string, state: FenceState | null): FenceState | null {
  const m = FENCE_RE.exec(line);
  if (!state) {
    if (!m) return null;
    const marker = m[1]!;
    // Cerca de crase não pode ter crase no info string (senão é código inline).
    if (marker[0] === "`" && m[2]!.includes("`")) return null;
    return { char: marker[0]!, len: marker.length };
  }
  // Fechamento: mesma espécie, comprimento >=, e nada além de espaços depois.
  if (m && m[1]![0] === state.char && m[1]!.length >= state.len && m[2]!.trim() === "") {
    return null;
  }
  return state;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ----------------------------------------------------------------- postProcess

/**
 * Colapsa mais de duas linhas em branco seguidas em duas, remove espaços no fim
 * das linhas e garante um único `\n` final. Nada muda dentro de blocos cercados.
 * O `\` do `<br>` não é espaço e permanece.
 */
export function postProcess(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: FenceState | null = null;
  let blanks = 0;

  for (const raw of lines) {
    if (fence) {
      out.push(raw);
      fence = nextFenceState(raw, fence);
      continue;
    }
    const line = raw.replace(/[ \t\f\v ]+$/, "");
    if (line === "") {
      blanks++;
      if (blanks <= 2) out.push("");
      continue;
    }
    blanks = 0;
    out.push(line);
    fence = nextFenceState(line, null);
  }

  // Remove brancos no início e no fim do documento (fora de cerca, já que o
  // último elemento pode ser a última linha de um bloco de código).
  let start = 0;
  while (start < out.length && out[start] === "") start++;
  let end = out.length;
  while (end > start && out[end - 1] === "") end--;
  if (start >= end) return "";
  return out.slice(start, end).join("\n") + "\n";
}

// -------------------------------------------------------------- ensureSingleH1

/** Linha de H1 ATX, opcionalmente precedida de âncoras `<a id="..."></a>` na mesma linha. */
const H1_RE = /^( {0,3}(?:<a\s[^>]*><\/a>\s*)*)#(?=[ \t]|$)/;

/** Texto do primeiro H1 ATX do documento (fence-aware) ou undefined. */
export function firstH1(md: string): string | undefined {
  let fence: FenceState | null = null;
  for (const line of md.split("\n")) {
    if (fence) {
      fence = nextFenceState(line, fence);
      continue;
    }
    fence = nextFenceState(line, null);
    if (fence) continue;
    const m = H1_RE.exec(line);
    if (m) {
      const text = line
        .slice(m[0].length)
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trim();
      return text || undefined;
    }
  }
  return undefined;
}

/**
 * Mantém o primeiro H1 e demove os seguintes para `##`. Sem nenhum H1, insere
 * `# fallbackTitle` no topo (se houver título). Nada é movido de lugar.
 */
export function ensureSingleH1(md: string, fallbackTitle: string | undefined): string {
  const lines = md.split("\n");
  let fence: FenceState | null = null;
  let seen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      fence = nextFenceState(line, fence);
      continue;
    }
    fence = nextFenceState(line, null);
    if (fence) continue;
    const m = H1_RE.exec(line);
    if (!m) continue;
    if (!seen) {
      seen = true;
    } else {
      lines[i] = m[1] + "##" + line.slice(m[0].length);
    }
  }

  const result = lines.join("\n");
  if (seen) return result;

  const title = fallbackTitle ? collapseWs(fallbackTitle) : "";
  if (!title) return result;
  const rest = result.replace(/^\n+/, "");
  return rest ? `# ${title}\n\n${rest}` : `# ${title}\n`;
}

// ---------------------------------------------------------------- collectLinks

/**
 * Coleta `<a href>` do nó: URLs absolutas (via `resolve`), sem href vazio,
 * `javascript:` ou fragmento puro (`#x`), sem âncoras sem texto, deduplicado
 * por (href, texto). `mailto:` e `tel:` são mantidos.
 */
export function collectLinks(root: Element, resolve: (raw: string) => string): LinkRecord[] {
  const seen = new Set<string>();
  const links: LinkRecord[] = [];

  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const raw = (a.getAttribute("href") ?? "").trim();
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;

    let text = collapseWs(a.textContent ?? "");
    if (!text) {
      const img = a.querySelector("img[alt]");
      text = collapseWs(img?.getAttribute("alt") ?? "");
    }
    if (!text) continue;

    const href = resolve(raw);
    const key = `${href}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text, href });
  }
  return links;
}

// --------------------------------------------------------- renderLinksSection

function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

/** Parênteses desbalanceados quebram o destino `(...)`; neles, codifica-os. */
function safeDestination(href: string): string {
  let depth = 0;
  let balanced = true;
  for (const ch of href) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) {
      balanced = false;
      break;
    }
  }
  if (balanced && depth === 0) return href.replace(/\s/g, "%20");
  return href.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Seção `## Links da página` com uma lista `- [Texto](url)`. Vazia se não houver links. */
export function renderLinksSection(links: LinkRecord[]): string {
  if (links.length === 0) return "";
  const items = links.map((l) => `- [${escapeLinkText(l.text)}](${safeDestination(l.href)})`);
  return `## Links da página\n\n${items.join("\n")}\n`;
}

// ------------------------------------------------------------- renderDocument

/** Valor YAML: escalar simples quando seguro, senão string entre aspas duplas (JSON é YAML válido). */
function yamlValue(v: string): string {
  const needsQuotes =
    v === "" ||
    /[\r\n\t"']/.test(v) ||
    /^\s|\s$/.test(v) ||
    /:(\s|$)/.test(v) ||
    /\s#/.test(v) ||
    /^[-?:,[\]{}#&*!|>%@`]/.test(v) ||
    /^(true|false|yes|no|on|off|null|~|y|n)$/i.test(v) ||
    /^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/.test(v) ||
    new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]").test(v);
  return needsQuotes ? JSON.stringify(v) : v;
}

/** Frontmatter YAML (`---`) na ordem do template da spec + linha em branco + corpo. */
export function renderDocument(fm: Frontmatter, body: string): string {
  const fields: Array<[string, string | undefined]> = [
    ["url", fm.url],
    ["canonical", fm.canonical],
    ["title", fm.title],
    ["description", fm.description],
    ["lang", fm.lang],
    ["fetched_at", fm.fetched_at],
    ["source", fm.source],
  ];
  const lines = fields
    .filter((f): f is [string, string] => f[1] !== undefined && f[1] !== "")
    .map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

// ------------------------------------------------------------------- paginate

/** Fração final do trecho em que procuramos um limite de parágrafo/linha para cortar. */
const CUT_WINDOW = 0.15;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Escolhe o ponto de corte (exclusivo) em (start, hardEnd]. */
function chooseCut(doc: string, start: number, hardEnd: number, maxChars: number): number {
  const windowStart = Math.max(start + 1, hardEnd - Math.floor(maxChars * CUT_WINDOW));
  // Prefere o último limite de parágrafo; depois o último limite de linha.
  const para = doc.lastIndexOf("\n\n", hardEnd - 2);
  if (para !== -1 && para + 2 >= windowStart && para + 2 > start) return para + 2;
  const nl = doc.lastIndexOf("\n", hardEnd - 1);
  if (nl !== -1 && nl + 1 >= windowStart && nl + 1 > start) return nl + 1;
  // Corte duro; não parte um par substituto UTF-16.
  if (hardEnd - 1 > start && isHighSurrogate(doc.charCodeAt(hardEnd - 1))) return hardEnd - 1;
  return hardEnd;
}

/**
 * Fatia `[startIndex, startIndex + maxChars)` do documento completo
 * (frontmatter + corpo), cortando num limite de parágrafo/linha quando possível.
 * `next_start_index` é a posição real do corte. Se truncado, anexa o marcador
 * de continuação. O frontmatter só aparece na primeira página porque é o
 * documento inteiro que é fatiado.
 */
export function paginate(doc: string, startIndex: number, maxChars: number): PageSlice {
  const total = doc.length;
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw errors.invalidArgument(`start_index inválido: ${startIndex}. Use um inteiro maior ou igual a 0.`);
  }
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw errors.invalidArgument(`max_chars inválido: ${maxChars}. Use um inteiro maior ou igual a 1.`);
  }
  if (total === 0) return { text: "", total_chars: 0, next_start_index: null };
  if (startIndex >= total) {
    throw errors.invalidArgument(
      `start_index=${startIndex} está além do fim do conteúdo: o documento tem ${total} caracteres no total. Use um start_index entre 0 e ${total - 1}.`,
    );
  }

  const hardEnd = startIndex + maxChars;
  if (hardEnd >= total) {
    return { text: doc.slice(startIndex), total_chars: total, next_start_index: null };
  }

  const cut = chooseCut(doc, startIndex, hardEnd, maxChars);
  const chunk = doc.slice(startIndex, cut).replace(/\s+$/, "");
  const marker = `\n\n---\n[Conteúdo truncado: exibidos caracteres ${startIndex}–${cut} de ${total}. Para continuar, chame novamente com start_index=${cut}]\n`;
  return { text: chunk + marker, total_chars: total, next_start_index: cut };
}
