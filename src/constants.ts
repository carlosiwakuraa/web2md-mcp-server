export const SERVER_NAME = "web2md-mcp-server";
export const SERVER_VERSION = "1.3.0";
export const TOOL_NAME = "web2md_fetch_markdown";
export const BATCH_TOOL_NAME = "web2md_fetch_markdown_batch";

/** Variável de ambiente que sobrescreve a pasta onde as conversões são salvas. */
export const OUTPUT_DIR_ENV = "WEB2MD_OUTPUT_DIR";

export const FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CHARS = 50_000;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export const ACCEPT_HEADER = "text/markdown, text/html;q=0.9";
export const USER_AGENT =
  "Mozilla/5.0 (compatible; web2md-mcp-server/1.0; +https://modelcontextprotocol.io)";

/** Heurística "depende de JavaScript": pouco texto visível e muitos <script>. */
export const JS_MIN_TEXT_CHARS = 200;
export const JS_MIN_SCRIPTS = 3;

/** Lote (v1.2): limites e padrões. */
export const MAX_BATCH_URLS = 20;
export const BATCH_CONCURRENCY = 4;
/** Até esta quantidade de arquivos o conteúdo pode vir inline; acima, o plano de subagentes. */
export const DEFAULT_INLINE_MAX_FILES = 3;
/** Quantidade de arquivos por subagente no plano de despacho. */
export const DEFAULT_FILES_PER_AGENT = 5;
/** Prazo global do lote: abaixo do timeout típico (60 s) dos clientes MCP. URLs não concluídas viram erro. */
export const BATCH_DEADLINE_MS = 50_000;

/** Retry (v1.3): tentativas extras após a primeira (3 tentativas no total). */
export const RETRY_MAX_RETRIES = 2;
/** Base do backoff exponencial (500 ms, 1 s, ...), com jitter. */
export const RETRY_BASE_DELAY_MS = 500;
/** Teto de espera entre tentativas, inclusive quando vem de Retry-After. */
export const RETRY_MAX_DELAY_MS = 10_000;
/** Status HTTP que valem nova tentativa. */
export const RETRY_STATUS_CODES: readonly number[] = [429, 502, 503, 504];
/** Códigos de erro de rede transitórios que valem nova tentativa. */
export const RETRY_NETWORK_CODES: readonly string[] = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"];

/** Pasta de saída (segurança): retenção e teto do documento salvo. */
/** Variável opcional: dias de retenção dos arquivos salvos (0 desativa a limpeza). */
export const RETENTION_DAYS_ENV = "WEB2MD_RETENTION_DAYS";
export const DEFAULT_RETENTION_DAYS = 7;
/** Teto do documento salvo: acima do que o fetch consegue produzir (MAX_BODY_BYTES), só barra abuso. */
export const MAX_SAVED_DOC_BYTES = 2 * MAX_BODY_BYTES;
