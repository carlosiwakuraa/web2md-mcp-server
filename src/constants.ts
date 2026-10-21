export const SERVER_NAME = "web2md-mcp-server";
export const SERVER_VERSION = "1.1.0";
export const TOOL_NAME = "web2md_fetch_markdown";

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
