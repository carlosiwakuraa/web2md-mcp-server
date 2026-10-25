import { detect as detectCharset } from "chardet";
import iconv from "iconv-lite";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import {
  ACCEPT_HEADER,
  FETCH_TIMEOUT_MS,
  MAX_BODY_BYTES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_MAX_RETRIES,
  RETRY_NETWORK_CODES,
  RETRY_STATUS_CODES,
  USER_AGENT,
} from "../constants.js";
import { errors, Web2mdError } from "../errors.js";
import type { FetchOptions, FetchResult } from "../types.js";
import {
  getProxyDispatcher,
  readProxyEnv,
  redactSecrets,
  selectProxy,
  type ProxyChoice,
  type ProxyEnv,
} from "./proxy.js";

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
    /** Espera pedida pelo servidor via Retry-After, em ms (sem teto aplicado). */
    readonly retryAfterMs?: number,
  ) {
    // Retry-After acima do teto: não retentamos; avisa na mensagem (texto base preservado).
    const waitHint =
      retryAfterMs !== undefined && RETRY_STATUS_CODES.includes(status) && retryAfterMs > RETRY_MAX_DELAY_MS
        ? Math.ceil(retryAfterMs / 1000)
        : undefined;
    const base = errors.http(status, url, waitHint);
    super(base.code, base.message);
  }
}

/** Falha de rede/proxy, marcando se vale nova tentativa. */
class NetworkFailure extends Web2mdError {
  constructor(
    base: Web2mdError,
    readonly transient: boolean,
  ) {
    super(base.code, base.message);
  }
}

/** Retry-After em segundos ou data HTTP -> ms (>= 0); undefined se ausente/inválido. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
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

/** Todos os `code` na cadeia de causas (inclui AggregateError). */
function collectCodes(err: unknown, depth = 0, out: string[] = []): string[] {
  if (!err || typeof err !== "object" || depth > 5) return out;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string") out.push(e.code);
  collectCodes(e.cause, depth + 1, out);
  if (Array.isArray(e.errors)) for (const sub of e.errors) collectCodes(sub, depth + 1, out);
  return out;
}

function collectMessages(err: unknown, depth = 0, out: string[] = []): string[] {
  if (!err || typeof err !== "object" || depth > 5) return out;
  const e = err as { message?: unknown; cause?: unknown };
  if (typeof e.message === "string") out.push(e.message);
  collectMessages(e.cause, depth + 1, out);
  return out;
}

/** Códigos que, com proxy em uso, indicam falha ao alcançar o próprio proxy. */
const PROXY_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function mapError(
  err: unknown,
  url: string,
  timeoutMs: number,
  proxy: ProxyChoice | null,
  proxyEnv: ProxyEnv,
): Web2mdError {
  if (err instanceof Web2mdError) return err;
  const e = err as { name?: string; message?: string; cause?: unknown } | null;
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return errors.timeout(url, timeoutMs);
  }
  const cause = e?.cause as { code?: string; message?: string; name?: string } | undefined;
  if (cause && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return errors.timeout(url, timeoutMs);
  }

  const codes = collectCodes(err);
  const transient = codes.some((c) => RETRY_NETWORK_CODES.includes(c));
  // `code` de DOMException é numérico; só usamos códigos textuais (ex.: ECONNRESET).
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  const detail = redactSecrets(String(causeCode ?? cause?.message ?? e?.message ?? String(err)), proxyEnv);

  if (proxy) {
    const text = collectMessages(err).join(" | ");
    const tunnel = /Proxy response \((\d{3})\)/.exec(text);
    if (tunnel || /Proxy Authentication Required/i.test(text)) {
      const status = tunnel ? Number(tunnel[1]) : 407;
      if (status === 407) return new NetworkFailure(errors.proxyAuth(proxy.label, url), false);
      return new NetworkFailure(
        errors.proxyRefused(proxy.label, url, status),
        RETRY_STATUS_CODES.includes(status),
      );
    }
    if (codes.some((c) => PROXY_CONNECT_CODES.has(c))) {
      return new NetworkFailure(errors.proxyConnect(proxy.label, url, detail), transient);
    }
  }

  return new NetworkFailure(errors.network(url, detail), transient);
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

/** Contexto compartilhado pelas tentativas de uma chamada a fetchPage. */
interface FetchContext {
  fetchImpl: typeof fetch;
  dispatcher: Dispatcher | undefined;
  proxyEnv: ProxyEnv;
  /** Orçamento total (para a mensagem de timeout). */
  totalMs: number;
  /** Instante (Date.now) em que o orçamento acaba. */
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

async function fetchOnce(target: URL, ctx: FetchContext, timeoutMs: number): Promise<FetchResult> {
  const url = target.href;
  let proxy: ProxyChoice | null = null;
  try {
    proxy = selectProxy(target, ctx.proxyEnv);
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      method: "GET",
      redirect: "follow",
      headers: { Accept: ACCEPT_HEADER, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (ctx.dispatcher) init.dispatcher = ctx.dispatcher;
    const res = await ctx.fetchImpl(url, init);
    const finalUrl = res.url || url;

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 407 && proxy) throw errors.proxyAuth(proxy.label, url);
      throw new HttpFailure(res.status, url, parseRetryAfter(res.headers.get("retry-after"), ctx.now()));
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
    throw mapError(err, url, ctx.totalMs, proxy, ctx.proxyEnv);
  }
}

// ----------------------------------------------------------------------- retry

/** Espera (ms) antes da próxima tentativa, ou null se o erro não é repetível. */
function retryDelayMs(err: unknown, attempt: number, random: () => number): number | null {
  let retryAfter: number | undefined;
  if (err instanceof HttpFailure) {
    if (!RETRY_STATUS_CODES.includes(err.status)) return null;
    retryAfter = err.retryAfterMs;
  } else if (err instanceof NetworkFailure) {
    if (!err.transient) return null;
  } else {
    return null; // timeout, tipo não suportado, URL inválida, corpo grande, etc.
  }
  if (retryAfter !== undefined) {
    // O servidor pediu mais do que toleramos esperar: retentar antes só martelaria o host.
    if (retryAfter > RETRY_MAX_DELAY_MS) return null;
    return retryAfter;
  }
  // Backoff exponencial com jitter entre 50% e 100% do valor nominal.
  const nominal = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(Math.round(nominal * (0.5 + random() * 0.5)), RETRY_MAX_DELAY_MS);
}

async function fetchWithRetry(target: URL, ctx: FetchContext): Promise<FetchResult> {
  for (let attempt = 0; ; attempt++) {
    const remaining = ctx.deadline - ctx.now();
    if (remaining <= 0) throw errors.timeout(target.href, ctx.totalMs);
    try {
      return await fetchOnce(target, ctx, remaining);
    } catch (err) {
      if (attempt >= RETRY_MAX_RETRIES) throw err;
      const delay = retryDelayMs(err, attempt, ctx.random);
      if (delay === null) throw err;
      // Sem tempo para esperar e ainda tentar de novo: falha agora, sem estourar o orçamento.
      if (delay >= ctx.deadline - ctx.now()) throw err;
      await ctx.sleep(delay);
    }
  }
}

// -------------------------------------------------------------------------- API

/** Extensões de FetchOptions voltadas a testes; a pipeline não precisa informá-las. */
export interface FetchPageOptions extends FetchOptions {
  /** Padrão: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Padrão: setTimeout real. */
  sleep?: (ms: number) => Promise<void>;
  /** Padrão: Math.random (jitter do backoff). */
  random?: () => number;
  /** Padrão: Date.now. */
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchPage(rawUrl: string, opts: FetchPageOptions = {}): Promise<FetchResult> {
  const url = parseUrl(rawUrl);
  const proxyEnv = readProxyEnv(opts.env ?? process.env);
  const dispatcher = getProxyDispatcher(proxyEnv);
  // O fetch embutido do Node não aceita com segurança um Dispatcher de outra cópia do undici:
  // com proxy, usamos o fetch do próprio undici.
  const fetchImpl = opts.fetchImpl ?? (dispatcher ? (undiciFetch as unknown as typeof fetch) : globalThis.fetch);
  const totalMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const ctx: FetchContext = {
    fetchImpl,
    dispatcher,
    proxyEnv,
    totalMs,
    deadline: now() + totalMs,
    now,
    sleep: opts.sleep ?? realSleep,
    random: opts.random ?? Math.random,
  };

  const alt = findRewrite(url);
  if (alt) {
    try {
      return await fetchWithRetry(alt, ctx);
    } catch (err) {
      // 429 (e demais status já retentados) esgotados não caem para a URL original: é o mesmo host.
      const fallbackable =
        (err instanceof HttpFailure &&
          err.status >= 400 &&
          err.status < 500 &&
          !RETRY_STATUS_CODES.includes(err.status)) ||
        (err instanceof Web2mdError && err.code === "UNSUPPORTED_CONTENT_TYPE");
      if (!fallbackable) throw err;
    }
    // O fallback tem orçamento próprio (totalMs segue como teto por URL).
    return fetchWithRetry(url, { ...ctx, deadline: now() + totalMs });
  }
  return fetchWithRetry(url, ctx);
}
