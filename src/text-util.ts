/**
 * Utilitários de texto em tempo linear.
 *
 * Regex com quantificador sem âncora de início (`X+` seguido de `$`, espaço-opcional
 * em volta de `\n`, contrabarras opcionais antes de `|`) são quadráticas no V8:
 * cada posição de partida reexplora a corrida inteira.
 * Tudo que processa texto vindo da página usa estes helpers no lugar delas.
 */

/** Mesmo conjunto de `\s` do JavaScript (espaços, quebras de linha, NBSP, BOM, etc.). */
export function isJsWhitespace(c: number): boolean {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/**
 * Limita cada corrida de whitespace a `max` caracteres (mantém a metade inicial e a final, então
 * quebras de linha nas pontas sobrevivem). Corridas assim longas não existem em conteúdo real, e o
 * Turndown tem regex quadráticas sobre elas (`[\t\r\n\s]+$` no pós-processamento).
 */
export function capWhitespaceRuns(s: string, max = 256): string {
  if (s.length <= max) return s;
  const half = max >> 1;
  const n = s.length;
  let parts: string[] | null = null;
  let last = 0;
  let i = 0;
  while (i < n) {
    if (!isJsWhitespace(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isJsWhitespace(s.charCodeAt(i))) i++;
    if (i - start > max) {
      (parts ??= []).push(s.slice(last, start + half), s.slice(i - half, i));
      last = i;
    }
  }
  return parts === null ? s : parts.join("") + s.slice(last);
}

/** Equivalente linear de `s.replace(/[<chars>]+$/, "")`. */
export function trimEndSet(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Equivalente linear de `s.replace(/^[<chars>]+/, "")`. */
export function trimStartSet(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start]!)) start++;
  return start === 0 ? s : s.slice(start);
}

/** Remove `\n` do início e do fim (equivalente linear de `/^\n+/` e `/\n+$/`). */
export function trimNewlines(s: string): string {
  return trimStartSet(trimEndSet(s, "\n"), "\n");
}

/**
 * Equivalente linear de trocar `\s*\n\s*` (global) por `replacement`: cada corrida
 * maximal de espaço em branco que contém quebra de linha vira `replacement`.
 * `\r` também conta como quebra (CommonMark a trata como fim de linha).
 */
export function collapseLineBreaks(s: string, replacement = " "): string {
  if (!s.includes("\n") && !s.includes("\r")) return s;
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (!isJsWhitespace(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const runStart = i;
    let hasBreak = false;
    while (i < n && isJsWhitespace(s.charCodeAt(i))) {
      const c = s.charCodeAt(i);
      if (c === 10 || c === 13) hasBreak = true;
      i++;
    }
    if (hasBreak) {
      parts.push(s.slice(last, runStart), replacement);
      last = i;
    }
  }
  if (last === 0) return s;
  parts.push(s.slice(last));
  return parts.join("");
}

/**
 * Remove a sequência de fechamento ATX (de `## Título ##` para `## Título`): hashes
 * finais precedidos de espaço/tab (ou a linha inteira só de hashes). Linear.
 */
export function stripClosingHashes(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t")) end--;
  let h = end;
  while (h > 0 && s[h - 1] === "#") h--;
  if (h === end) return s; // sem hashes finais
  if (h === 0) {
    // só hashes (e espaços): no ATX original isso vira texto vazio
    return "";
  }
  if (s[h - 1] !== " " && s[h - 1] !== "\t") return s; // `foo#` não é sequência de fechamento
  while (h > 0 && (s[h - 1] === " " || s[h - 1] === "\t")) h--;
  return s.slice(0, h);
}

/** Texto de heading sem `#` final ambíguo: ` ##` no fim viraria sequência de fechamento ATX. */
export function escapeTrailingHashes(text: string): string {
  let h = text.length;
  while (h > 0 && text[h - 1] === "#") h--;
  if (h === text.length || h === 0 || text[h - 1] !== " ") return text;
  return `${text.slice(0, h)}\\${text.slice(h)}`;
}

/** Valor de whitespace/controle: usado para sanear ids e valores emitidos em atributos/linhas. */
// eslint-disable-next-line no-control-regex
const SPACE_OR_CONTROL_RE = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]+/g;

/** Remove todo whitespace e caractere de controle (ids de âncora, nomes). */
export function stripSpaceAndControls(s: string): string {
  return s.replace(SPACE_OR_CONTROL_RE, "");
}
