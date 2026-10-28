export type ErrorCode =
  | "INVALID_URL"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "PROXY_ERROR"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "EMPTY_CONTENT"
  | "JS_REQUIRED"
  | "INVALID_ARGUMENT"
  | "SECTION_NOT_FOUND"
  | "SECTION_AMBIGUOUS";

/** Erro com mensagem já pronta para o Claude (seção 6 da spec). */
export class Web2mdError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Web2mdError";
  }
}

/** Chaves de query cujo valor é mascarado nas mensagens (comparação sem diferenciar maiúsculas). */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "key",
  "apikey",
  "api_key",
  "access_token",
  "auth",
  "password",
  "pwd",
  "secret",
  "sig",
  "signature",
  "session",
  "sid",
  "code",
]);

function isSensitiveKey(rawKey: string): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // percent-encoding malformado: compara o texto cru.
  }
  return SENSITIVE_QUERY_KEYS.has(key.toLowerCase());
}

/**
 * Versão segura da URL para mensagens de erro: remove `user:pass@` e troca por `***` o valor de
 * parâmetros sensíveis (token, key, password, sig, ...) na query e no fragmento. Funciona também
 * com texto que não é uma URL válida. Não altera o resto da URL.
 */
export function redactUrl(raw: string): string {
  return raw
    .replace(/^((?:[^\s/?#]*:)?\/\/)[^/?#\s]*@/, "$1")
    .replace(/([?&;#])([^=&#;\s]*)=([^&#\s]*)/g, (match, sep: string, key: string) =>
      isSensitiveKey(key) ? `${sep}${key}=***` : match,
    );
}

export const errors = {
  invalidUrl: (raw: string) =>
    new Web2mdError(
      "INVALID_URL",
      `URL inválida: "${redactUrl(raw)}". Use uma URL absoluta http:// ou https://.`,
    ),
  http: (status: number, url: string, retryAfterSeconds?: number) =>
    new Web2mdError(
      "HTTP_ERROR",
      `Erro HTTP ${status} ao acessar ${redactUrl(url)}` +
        (retryAfterSeconds !== undefined
          ? `. O servidor pediu para aguardar ${retryAfterSeconds} s antes de nova tentativa; não repeti automaticamente.`
          : ""),
    ),
  timeout: (url: string, ms: number) =>
    new Web2mdError(
      "TIMEOUT",
      `Timeout de ${Math.round(ms / 1000)} s ao acessar ${redactUrl(url)}. O servidor não respondeu a tempo; tente novamente.`,
    ),
  network: (url: string, detail: string) =>
    new Web2mdError("NETWORK_ERROR", `Falha de rede ao acessar ${redactUrl(url)}: ${detail}`),
  /** `proxy` é sempre o rótulo "host:porta", nunca a URL completa (pode ter credenciais). */
  proxyConnect: (proxy: string, url: string, detail: string) =>
    new Web2mdError(
      "PROXY_ERROR",
      `Falha ao conectar ao proxy ${proxy} ao acessar ${redactUrl(url)}:${detail}. Verifique HTTPS_PROXY/HTTP_PROXY e se o proxy está acessível.`,
    ),
  proxyAuth: (proxy: string, url: string) =>
    new Web2mdError(
      "PROXY_ERROR",
      `O proxy ${proxy} exige autenticação (HTTP 407) ao acessar ${redactUrl(url)}. Informe usuário e senha na URL do proxy (http://usuario:senha@host:porta) ou confira as credenciais.`,
    ),
  proxyRefused: (proxy: string, url: string, status: number) =>
    new Web2mdError(
      "PROXY_ERROR",
      `O proxy ${proxy} recusou a conexão com ${redactUrl(url)} (HTTP ${status}). O destino pode estar bloqueado pelo proxy ou fora do ar.`,
    ),
  /** `varName` é o nome da variável de ambiente; o valor nunca entra na mensagem. */
  proxyConfig: (varName: string) =>
    new Web2mdError(
      "PROXY_ERROR",
      `Configuração de proxy inválida em ${varName}. Use o formato http://host:porta (ou http://usuario:senha@host:porta).`,
    ),
  unsupportedContentType: (contentType: string, url: string) =>
    new Web2mdError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Content-type não suportado (${contentType || "desconhecido"}) em ${redactUrl(url)}. Esta ferramenta converte apenas páginas HTML (ou Markdown nativo).`,
    ),
  emptyContent: (mode: "article" | "full") =>
    new Web2mdError(
      "EMPTY_CONTENT",
      mode === "article"
        ? 'A página ficou vazia após a extração do conteúdo principal. Tente novamente com mode="full".'
        : "A página não tem conteúdo de texto para converter.",
    ),
  jsRequired: (url: string) =>
    new Web2mdError(
      "JS_REQUIRED",
      `A página ${redactUrl(url)} provavelmente depende de JavaScript para renderizar o conteúdo (pouco texto e muitos <script>). Esta versão não executa JavaScript.`,
    ),
  invalidArgument: (detail: string) => new Web2mdError("INVALID_ARGUMENT", detail),
  /** `message` já vem pronta (lista os headings disponíveis); ver stages/outline.ts. */
  sectionNotFound: (message: string) => new Web2mdError("SECTION_NOT_FOUND", message),
  sectionAmbiguous: (message: string) => new Web2mdError("SECTION_AMBIGUOUS", message),
};
