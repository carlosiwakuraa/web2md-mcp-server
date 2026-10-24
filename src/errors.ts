export type ErrorCode =
  | "INVALID_URL"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "PROXY_ERROR"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "EMPTY_CONTENT"
  | "JS_REQUIRED"
  | "INVALID_ARGUMENT";

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

export const errors = {
  invalidUrl: (raw: string) =>
    new Web2mdError(
      "INVALID_URL",
      `URL inválida: "${raw}". Use uma URL absoluta http:// ou https://.`,
    ),
  http: (status: number, url: string) =>
    new Web2mdError("HTTP_ERROR", `Erro HTTP ${status} ao acessar ${url}`),
  timeout: (url: string, ms: number) =>
    new Web2mdError(
      "TIMEOUT",
      `Timeout de ${Math.round(ms / 1000)} s ao acessar ${url}. O servidor não respondeu a tempo; tente novamente.`,
    ),
  network: (url: string, detail: string) =>
    new Web2mdError("NETWORK_ERROR", `Falha de rede ao acessar ${url}: ${detail}`),
  /** `proxy` é sempre o rótulo "host:porta", nunca a URL completa (pode ter credenciais). */
  proxyConnect: (proxy: string, url: string, detail: string) =>
    new Web2mdError(
      "PROXY_ERROR",
      `Falha ao conectar ao proxy ${proxy} ao acessar ${url}: ${detail}. Verifique HTTPS_PROXY/HTTP_PROXY e se o proxy está acessível.`,
    ),
  proxyAuth: (proxy: string, url: string) =>
    new Web2mdError(
      "PROXY_ERROR",
      `O proxy ${proxy} exige autenticação (HTTP 407) ao acessar ${url}. Informe usuário e senha na URL do proxy (http://usuario:senha@host:porta) ou confira as credenciais.`,
    ),
  proxyRefused: (proxy: string, url: string, status: number) =>
    new Web2mdError(
      "PROXY_ERROR",
      `O proxy ${proxy} recusou a conexão com ${url} (HTTP ${status}). O destino pode estar bloqueado pelo proxy ou fora do ar.`,
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
      `Content-type não suportado (${contentType || "desconhecido"}) em ${url}. Esta ferramenta converte apenas páginas HTML (ou Markdown nativo).`,
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
      `A página ${url} provavelmente depende de JavaScript para renderizar o conteúdo (pouco texto e muitos <script>). Esta versão não executa JavaScript.`,
    ),
  invalidArgument: (detail: string) => new Web2mdError("INVALID_ARGUMENT", detail),
};
