import { detect as detectCharset } from "chardet";
import iconv from "iconv-lite";
import { ACCEPT_HEADER, FETCH_TIMEOUT_MS, MAX_BODY_BYTES, USER_AGENT } from "../constants.js";
import { errors, Web2mdError } from "../errors.js";
import type { FetchOptions, FetchResult } from "../types.js";

// ------------------------------------------------------------ regras por domínio

/**
 * Regra de reescrita de URL por domínio. `rewrite` devolve a URL alternativa a
 * tentar primeiro, ou null se a regra não se aplica. Se a alternativa falhar
 * (HTTP 4xx ou content-type não suportado), caímos para a URL original.
 */
interface DomainRule {
  /** Hostname exato ou sufixo de domínio (ex.: "developer.apple.com"). */
  host: string;
  rewrite(url: URL): URL | null;
}

const DOMAIN_RULES: DomainRule[] = [
  {
    host: "developer.apple.com",
    rewrite(url) {
      const path = url.pathname;
      if (!path.startsWith("/documentation/") || path.toLowerCase().endsWith(".md")) return null;
      const next = new URL(url.href);
      next.pathname = path.replace(/\/+$/, "") + ".md";
      next.hash = "";
      return next;
    },
  },
];

function findRewrite(url: URL): URL | null {
  const host = url.hostname.toLowerCase();
  for (const rule of DOMAIN_RULES) {
    if (host === rule.host || host.endsWith(`.${rule.host}`)) {
      const alt = rule.rewrite(url);
      if (alt) return alt;
    }
  }
  return null;
}

// ------------------------------------------------------------------ utilitários

/** Erro HTTP com o status preservado (para decidir o fallback). */
class HttpFailure extends Web2mdError {
  constructor(
    readonly status: number,
    url: string,
  ) {
    const base = errors.http(status, url);
    super(base.code, base.message);
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw errors.invalidUrl(raw);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw errors.invalidUrl(raw);
  return url;
}

function parseContentType(header: string | null): { type: string; charset?: string } {
  if (!header) return { type: "" };
  const [typePart, ...params] = header.split(";");
  let charset: string | undefined;
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^"\s;]+)"?\s*$/i.exec(p);
    if (m) charset = m[1];
  }
  return { type: (typePart ?? "").trim().toLowerCase(), charset };
}

function mapError(err: unknown, url: string, timeoutMs: number): Web2mdError {
  if (err instanceof Web2mdError) return err;
  const e = err as { name?: string; message?: string; cause?: unknown } | null;
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return errors.timeout(url, timeoutMs);
  }
  const cause = e?.cause as { code?: string; message?: string; name?: string } | undefined;
  if (cause && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return errors.timeout(url, timeoutMs);
  }
  const detail = cause?.code ?? cause?.message ?? e?.message ?? String(err);
  return errors.network(url, detail);
}

/** Lê o corpo como stream, abortando se passar de MAX_BODY_BYTES. */
async function readBody(res: Response, url: string): Promise<Buffer> {
  const limitMb = Math.round(MAX_BODY_BYTES / (1024 * 1024));
  const tooBig = () =>
    errors.network(url, `a resposta excede o limite de ${limitMb} MB e foi descartada`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

// ------------------------------------------------------------------- decodificação

/** Normaliza o nome do charset; null se o iconv-lite não o conhece. */
function normalizeCharset(label: string | null | undefined): string | null {
  if (!label) return null;
  let name = label.trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!name) return null;
  // Convenção web (WHATWG): latin1/ascii são, na prática, windows-1252.
  if (["iso-8859-1", "iso8859-1", "latin1", "l1", "us-ascii", "ascii"].includes(name)) {
    name = "windows-1252";
  }
  if (name === "utf8") name = "utf-8";
  // utf-16 declarado em <meta> não pode ser real (o meta seria ilegível): trate como utf-8.
  return iconv.encodingExists(name) ? name : null;
}

function detectBom(buf: Buffer): { encoding: string; length: number } | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf-8", length: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf-16le", length: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf-16be", length: 2 };
  return null;
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function sniffMetaCharset(buf: Buffer): string | null {
  const head = buf.subarray(0, 4096).toString("latin1");
  // Cobre <meta charset="x"> e <meta http-equiv="Content-Type" content="...; charset=x">.
  const m = /<meta\s[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head);
  return m?.[1] ?? null;
}

function decodeWith(buf: Buffer, encoding: string): string {
  // stripBOM padrão do iconv-lite remove o BOM do início.
  return iconv.decode(buf, encoding);
}

function decodeText(buf: Buffer, headerCharset: string | undefined, isHtml: boolean): string {
  // 1. BOM tem precedência sobre qualquer declaração (como no HTML5).
  const bom = detectBom(buf);
  if (bom) return decodeWith(buf, bom.encoding);

  // 2. charset do header.
  const fromHeader = normalizeCharset(headerCharset);
  if (fromHeader) return decodeWith(buf, fromHeader);

  // 3. <meta> (só HTML).
  if (isHtml) {
    const fromMeta = normalizeCharset(sniffMetaCharset(buf));
    if (fromMeta && !fromMeta.startsWith("utf-16")) return decodeWith(buf, fromMeta);
  }

  // 4. UTF-8 válido é quase certamente UTF-8; senão, detecção automática.
  if (isValidUtf8(buf)) return decodeWith(buf, "utf-8");
  const guessed = normalizeCharset(detectCharset(buf));
  return decodeWith(buf, guessed ?? "utf-8");
}

function looksLikeHtml(buf: Buffer): boolean {
  const head = buf
    .subarray(0, 1024)
    .toString("latin1")
    .replace(/^(\xef\xbb\xbf)?\s+/, "")
    .toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<head") ||
    head.startsWith("<body")
  );
}

// --------------------------------------------------------------------- fetch único

async function fetchOnce(
  target: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FetchResult> {
  const url = target.href;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: ACCEPT_HEADER, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const finalUrl = res.url || url;

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpFailure(res.status, url);
    }

    const { type, charset } = parseContentType(res.headers.get("content-type"));
    const isMarkdown = type === "text/markdown" || type === "text/x-markdown";
    const isHtmlType = type === "text/html" || type === "application/xhtml+xml";
    if (type && !isMarkdown && !isHtmlType) {
      await res.body?.cancel().catch(() => undefined);
      throw errors.unsupportedContentType(type, url);
    }

    const body = await readBody(res, url);

    if (isMarkdown) {
      return { kind: "native-markdown", finalUrl, markdown: decodeText(body, charset, false) };
    }
    if (!type && !looksLikeHtml(body)) {
      throw errors.unsupportedContentType("", url);
    }
    return { kind: "html", finalUrl, html: decodeText(body, charset, true) };
  } catch (err) {
    throw mapError(err, url, timeoutMs);
  }
}

// -------------------------------------------------------------------------- API

export async function fetchPage(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const url = parseUrl(rawUrl);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  const alt = findRewrite(url);
  if (alt) {
    try {
      return await fetchOnce(alt, fetchImpl, timeoutMs);
    } catch (err) {
      const fallbackable =
        (err instanceof HttpFailure && err.status >= 400 && err.status < 500) ||
        (err instanceof Web2mdError && err.code === "UNSUPPORTED_CONTENT_TYPE");
      if (!fallbackable) throw err;
    }
  }
  return fetchOnce(url, fetchImpl, timeoutMs);
}
