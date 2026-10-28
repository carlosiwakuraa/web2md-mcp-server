/**
 * Allowlist de esquemas para tudo que a conversão emite como href/src.
 *
 * As funções recebem a URL JÁ RESOLVIDA (saída de `ctx.resolveUrl`, que usa
 * `new URL(valor, base)`): o parser de URL do WHATWG remove tabs, quebras e
 * controles C0 iniciais antes de extrair o esquema, então `java&#9;script:`,
 * `\x01javascript:` e `JaVaScRiPt:` já chegam aqui como `javascript:` e caem
 * fora da allowlist. Um valor que não é URL absoluta válida é descartado (a
 * única exceção são fragmentos `#x`, que não têm esquema).
 */

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
const MEDIA_SCHEMES = new Set(["http:", "https:"]);
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+[;,]/i;

function parseAbsolute(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** href seguro (http, https, mailto, tel ou fragmento) ou null se o link deve ser descartado. */
export function safeLinkHref(resolved: string): string | null {
  const v = resolved.trim();
  if (v === "") return null;
  if (v.startsWith("#")) return v;
  const u = parseAbsolute(v);
  return u && LINK_SCHEMES.has(u.protocol) ? v : null;
}

/** URL segura para video/audio/iframe (só http/https) ou null. */
export function safeMediaUrl(resolved: string): string | null {
  const v = resolved.trim();
  const u = v === "" ? null : parseAbsolute(v);
  return u && MEDIA_SCHEMES.has(u.protocol) ? v : null;
}

/** src seguro para imagem: http/https ou `data:image/*`; qualquer outra coisa vira null. */
export function safeImageSrc(resolved: string): string | null {
  const v = resolved.trim();
  if (v === "") return null;
  if (DATA_IMAGE_RE.test(v)) return v;
  const u = parseAbsolute(v);
  return u && MEDIA_SCHEMES.has(u.protocol) ? v : null;
}
