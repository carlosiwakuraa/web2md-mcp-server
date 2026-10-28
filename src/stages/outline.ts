/**
 * Parse de headings do Markdown convertido, compartilhado pelo modo `outline`
 * e pelo parâmetro `section`. Uma única fonte de verdade para slugs e offsets.
 *
 * Todos os offsets são índices de string (UTF-16), os mesmos usados por
 * `total_chars` e `start_index`.
 */
import { errors } from "../errors.js";
import { nextFenceState, type FenceState } from "./postprocess.js";

export interface HeadingInfo {
  /** Texto puro do heading (sem marcação inline). */
  text: string;
  /** 1–6. */
  level: number;
  /** Âncora estável: slug do texto, único no documento (duplicados ganham -1, -2...). */
  slug: string;
  /** Id HTML original (`<a id="...">` emitido antes do heading), se houver. */
  id: string | null;
  /** Início da seção (inclui a linha de âncora `<a id>` que precede o heading). */
  start: number;
  /** Fim exclusivo: até o próximo heading de nível igual ou menor (ou o fim), sem linhas em branco finais. */
  end: number;
  /** end - start. */
  chars: number;
}

/** Máximo de headings listados nas mensagens de erro. */
export const MAX_LISTED_HEADINGS = 10;

// ------------------------------------------------------------------- texto

const ANCHOR_RE = /<a\s+[^>]*?\bid="([^"]*)"[^>]*><\/a>/g;
const ANCHOR_ONLY_RE = /^\s*(?:<a\s[^>]*><\/a>\s*)+$/;
const SAME_LINE_ANCHORS_RE = /^((?:<a\s[^>]*><\/a>\s*)+)(#.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
// Linhas que nunca são conteúdo de parágrafo para fins de setext.
const NON_PARAGRAPH_RE = /^(?: {4,}|\t|\s*>|\s*[-*+](?:[ \t]|$)|\s*\d{1,9}[.)](?:[ \t]|$)|\s*\|)/;
const THEMATIC_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Remove a marcação inline do Markdown, deixando só o texto visível. */
export function plainText(md: string): string {
  return md
    .replace(ANCHOR_RE, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:[^>\s]*)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/(`+)([^`]*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\\\w])([*_])(.+?)\2(?!\w)/g, "$1$3")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~$])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minúsculas, sem acentos, espaços colapsados. Base da comparação de textos. */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Slug estilo GitHub: minúsculas, sem acentos, só letras/dígitos/hífen/underscore. */
export function slugify(text: string): string {
  return foldText(text)
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ------------------------------------------------------------------- parse

interface RawHeading {
  text: string;
  level: number;
  id: string | null;
  start: number;
}

function anchorIds(line: string): string[] {
  return Array.from(line.matchAll(ANCHOR_RE), (m) => unescapeAttr(m[1]!)).filter(Boolean);
}

/**
 * Lista os headings (ATX e setext) fora de blocos de código cercados, em ordem
 * de aparição, com slugs únicos e o intervalo [start, end) de cada seção.
 */
export function parseHeadings(md: string): HeadingInfo[] {
  const lines = md.split("\n");
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }

  const raw: RawHeading[] = [];
  let fence: FenceState | null = null;
  let para: number[] = []; // índices das linhas do parágrafo corrente
  let anchor: { line: number; ids: string[] } | null = null;

  /** Início da seção: a linha de âncora imediatamente anterior entra na seção. */
  const startOf = (firstLine: number): { start: number; id: string | null } => {
    if (anchor && anchor.line === firstLine - 1) {
      return { start: offsets[firstLine - 1]!, id: anchor.ids[0] ?? null };
    }
    return { start: offsets[firstLine]!, id: null };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (fence) {
      fence = nextFenceState(line, fence);
      continue;
    }
    const opened = nextFenceState(line, null);
    if (opened) {
      fence = opened;
      para = [];
      continue;
    }

    if (line.trim() === "") {
      para = [];
      continue;
    }

    if (ANCHOR_ONLY_RE.test(line)) {
      para = [];
      anchor = { line: i, ids: anchorIds(line) };
      continue;
    }

    // ATX, opcionalmente com âncoras na mesma linha antes do `#`.
    const sameLine = SAME_LINE_ANCHORS_RE.exec(line);
    const atx = ATX_RE.exec(sameLine ? sameLine[2]! : line);
    if (atx) {
      para = [];
      const content = atx[2]!.replace(/[ \t]+#+[ \t]*$/, "").replace(/^[ \t]*#+[ \t]*$/, "");
      const text = plainText(content);
      if (sameLine) {
        raw.push({ text, level: atx[1]!.length, id: anchorIds(sameLine[1]!)[0] ?? null, start: offsets[i]! });
      } else {
        const { start, id } = startOf(i);
        raw.push({ text, level: atx[1]!.length, id, start });
      }
      continue;
    }

    const setext = SETEXT_RE.exec(line);
    if (setext && para.length > 0) {
      // Parágrafo + sublinhado: heading setext (CommonMark: "---" após parágrafo é setext, não hr).
      const text = plainText(para.map((n) => lines[n]!.trim()).join(" "));
      const { start, id } = startOf(para[0]!);
      raw.push({ text, level: setext[1]![0] === "=" ? 1 : 2, id, start });
      para = [];
      continue;
    }

    if (THEMATIC_RE.test(line) || NON_PARAGRAPH_RE.test(line)) {
      para = [];
      continue;
    }
    para.push(i);
  }

  // Slugs únicos (estilo GitHub: slug, slug-1, slug-2...).
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const headings: HeadingInfo[] = raw.map((h) => {
    const base = slugify(h.text) || "secao";
    let slug = base;
    let n = counts.get(base) ?? 0;
    while (used.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    counts.set(base, n);
    used.add(slug);
    return { text: h.text, level: h.level, slug, id: h.id, start: h.start, end: 0, chars: 0 };
  });

  // Fim da seção: início do próximo heading de nível <= ao dele (sem brancos finais).
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    let limit = md.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        limit = headings[j]!.start;
        break;
      }
    }
    const trimmed = md.slice(h.start, limit).replace(/\s+$/, "");
    const hadNewline = limit > h.start + trimmed.length;
    h.end = h.start + trimmed.length + (hadNewline ? 1 : 0);
    h.chars = h.end - h.start;
  }
  return headings;
}

/** Cópia dos headings com os offsets deslocados (ex.: do corpo para o documento com frontmatter). */
export function shiftHeadings(headings: HeadingInfo[], delta: number): HeadingInfo[] {
  return headings.map((h) => ({ ...h, start: h.start + delta, end: h.end + delta }));
}

/** Texto da seção (heading + subseções) dentro de `md`, de onde os headings foram parseados. */
export function sliceSection(md: string, heading: HeadingInfo): string {
  return md.slice(heading.start, heading.end);
}

/** Headings que pertencem à seção `root` (ela mesma e as subseções). */
export function subtree(headings: HeadingInfo[], root: HeadingInfo): HeadingInfo[] {
  return headings.filter((h) => h.start >= root.start && h.end <= root.end);
}

// -------------------------------------------------------------- resolução

function listHeadings(headings: HeadingInfo[]): string {
  const shown = headings.slice(0, MAX_LISTED_HEADINGS).map((h) => `- ${h.slug} — "${h.text}" (h${h.level})`);
  const rest = headings.length - shown.length;
  if (rest > 0) shown.push(`... e mais ${rest}`);
  return shown.join("\n");
}

function notFound(query: string, headings: HeadingInfo[]) {
  if (headings.length === 0) {
    return errors.sectionNotFound(`Seção "${query}" não encontrada: o documento convertido não tem headings.`);
  }
  return errors.sectionNotFound(
    `Seção "${query}" não encontrada. Headings disponíveis (use o slug ou o texto em "section"):\n${listHeadings(headings)}`,
  );
}

function ambiguous(query: string, candidates: HeadingInfo[]) {
  return errors.sectionAmbiguous(
    `A seção "${query}" é ambígua: casa com ${candidates.length} headings. Use o slug exato de um deles em "section":\n${listHeadings(candidates)}`,
  );
}

/**
 * Localiza a seção pedida em `section`.
 * Ordem: slug/id exato; texto exato (sem acento/caixa); prefixo; contém.
 * Prefixo e contém só valem se unívocos. Lança erro descritivo (português) se
 * não houver correspondência ou se for ambígua.
 */
export function resolveSection(headings: HeadingInfo[], query: string): HeadingInfo {
  const raw = query.trim().replace(/^#{1,6}\s+/, "").replace(/^#(?=\S)/, "");
  const q = foldText(raw);
  if (!q) throw notFound(query, headings);
  const qSlug = slugify(raw);

  // 1) slug ou id exato.
  const byKey =
    headings.find((h) => h.slug === raw || h.id === raw) ?? headings.find((h) => h.slug === raw.toLowerCase());
  if (byKey) return byKey;

  // 2) texto exato.
  const exact = headings.filter((h) => foldText(h.text) === q || (qSlug !== "" && h.slug === qSlug));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw ambiguous(query, exact);

  // 3) prefixo, 4) contém.
  const tests: Array<(h: HeadingInfo) => boolean> = [
    (h) => foldText(h.text).startsWith(q) || (qSlug !== "" && h.slug.startsWith(qSlug)),
    (h) => foldText(h.text).includes(q) || (qSlug !== "" && h.slug.includes(qSlug)),
  ];
  for (const test of tests) {
    const found = headings.filter(test);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) throw ambiguous(query, found);
  }
  throw notFound(query, headings);
}

/**
 * Casa o fragmento da URL (`#x`) com o id HTML ou o slug de um heading.
 * Estrito (sem prefixo/contém) e silencioso: devolve undefined se não casar.
 */
export function matchFragment(headings: HeadingInfo[], fragment: string): HeadingInfo | undefined {
  let frag = fragment.replace(/^#/, "");
  if (!frag || frag.startsWith(":~:")) return undefined;
  try {
    frag = decodeURIComponent(frag);
  } catch {
    // percent-encoding malformado: usa o valor cru.
  }
  const lower = frag.toLowerCase();
  const slugged = slugify(frag);
  return (
    headings.find((h) => h.id === frag) ??
    headings.find((h) => h.slug === frag) ??
    headings.find((h) => h.id !== null && h.id.toLowerCase() === lower) ??
    headings.find((h) => h.slug === lower || (slugged !== "" && h.slug === slugged))
  );
}

// ------------------------------------------------------------------ outline

/** Aviso de índice cortado (em português; vai no fim do texto do outline). */
export function outlineTruncationNotice(shown: number, total: number): string {
  return `[Índice truncado: exibidos ${shown} de ${total} headings. Use section="<slug>" numa seção pai, ou aumente max_chars, para ver o restante]`;
}

/**
 * Índice hierárquico em Markdown (lista aninhada pela pilha de níveis).
 *
 * `maxChars` limita o tamanho do texto devolvido (padrão: sem limite). Se o índice completo não couber,
 * mostra só os primeiros N itens que cabem (sempre linhas inteiras, na ordem do documento) e termina com
 * `outlineTruncationNotice`. O resultado nunca passa de `maxChars`: se nem o cabeçalho e o aviso couberem,
 * descarta a introdução, depois o título, e por fim corta o próprio aviso.
 */
export function renderOutline(
  headings: HeadingInfo[],
  totalChars: number,
  title?: string,
  maxChars: number = Number.POSITIVE_INFINITY,
): string {
  const head = title ? `# Outline: ${title.replace(/\s+/g, " ")}` : "# Outline";
  const intro =
    `Documento completo: ${totalChars} caracteres. ` +
    `Offsets são posições de caracteres no documento completo salvo (frontmatter incluído). ` +
    `Para ler uma seção, chame de novo com section="<slug>".`;
  if (headings.length === 0) return `${head}\n\n${intro}\n\nNenhum heading encontrado.\n`;

  const stack: number[] = [];
  const items = headings.map((h) => {
    while (stack.length > 0 && stack[stack.length - 1]! >= h.level) stack.pop();
    const indent = "  ".repeat(stack.length);
    stack.push(h.level);
    const label = h.text || "(sem texto)";
    return `${indent}- ${label} (h${h.level}) — slug: \`${h.slug}\` — offset ${h.start}–${h.end} (${h.chars} caracteres)`;
  });
  const full = `${head}\n\n${intro}\n\n${items.join("\n")}\n`;
  if (full.length <= maxChars) return full;

  // Não cabe: prefixos do mais completo ao mais enxuto; em cada um, o maior N de itens que cabe junto do aviso.
  const prefixes = [`${head}\n\n${intro}\n\n`, `${head}\n\n`, ""];
  for (const prefix of prefixes) {
    let best = -1;
    let itemsLen = 0; // tamanho de items[0..n) unidos por "\n"
    for (let n = 0; n < items.length; n++) {
      if (n > 0) itemsLen += items[n - 1]!.length + (n > 1 ? 1 : 0);
      const notice = outlineTruncationNotice(n, items.length);
      // prefixo + itens + "\n\n" (só se houver itens) + aviso + "\n"
      const len = prefix.length + (n > 0 ? itemsLen + 2 : 0) + notice.length + 1;
      if (len > maxChars) break; // o tamanho só cresce com n
      best = n;
    }
    if (best >= 0) {
      const shown = items.slice(0, best);
      return `${prefix}${best > 0 ? `${shown.join("\n")}\n\n` : ""}${outlineTruncationNotice(best, items.length)}\n`;
    }
  }
  return `${outlineTruncationNotice(0, items.length)}\n`.slice(0, Math.max(0, maxChars));
}
