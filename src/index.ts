#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME, SERVER_VERSION, TOOL_NAME } from "./constants.js";
import { Web2mdError } from "./errors.js";
import { saveConversion } from "./output.js";
import { runPipeline } from "./pipeline.js";
import { InputSchema, OutputSchema } from "./schemas/input.js";
import type { ToolInput } from "./types.js";

const TOOL_TITLE = "Converter página web em Markdown";

const TOOL_DESCRIPTION = `Busca uma URL a partir da máquina local e devolve o conteúdo da página como Markdown (GFM) fiel à estrutura original: títulos, listas, tabelas, blocos de código com linguagem, links e imagens com URLs absolutas, avisos (> [!NOTE]) e fórmulas ($...$).

Parâmetros:
- url (obrigatório): URL http:// ou https:// da página.
- mode: "article" (padrão) extrai só o conteúdo principal (main/article, sem menu, rodapé e barra lateral). Use "full" para converter o <body> inteiro quando "article" devolver pouco conteúdo ou o conteúdo errado.
- max_chars: limite de caracteres por resposta (padrão 50000).
- start_index: posição do documento onde a resposta começa (padrão 0), para paginar.
- include_links: se true, anexa a seção "## Links da página" com todos os links do conteúdo.

Retorno: texto Markdown com um frontmatter YAML (url, canonical, title, description, lang, fetched_at, source), seguido do corpo com um único H1. Se o servidor responder com Markdown nativo, ele é devolvido diretamente (source: native-markdown). O structuredContent traz { url, source, total_chars, next_start_index, saved_path }.

Salvamento: toda conversão bem-sucedida é gravada na pasta output/ do projeto (ou em WEB2MD_OUTPUT_DIR, se definida), sempre com o documento completo, independentemente de max_chars/start_index. saved_path traz o caminho absoluto do arquivo (null se a gravação falhar). Reconverter a mesma URL e modo sobrescreve o arquivo.

Paginação: se o documento passar de max_chars, a resposta termina com o marcador "[Conteúdo truncado: exibidos caracteres X–Y de TOTAL. Para continuar, chame novamente com start_index=N]" (e next_start_index no structuredContent). Chame de novo com o mesmo url/mode e start_index=N para ler o restante; o frontmatter só aparece na primeira parte. Um start_index além do fim do documento é um erro.

Erros (isError, com mensagem descritiva): URL inválida; Erro HTTP 4xx/5xx; timeout (30 s); falha de rede; content-type não suportado (só HTML e Markdown; PDFs e imagens não são convertidos); página vazia após a extração (tente mode="full"); página que depende de JavaScript para renderizar (não há execução de JS). Não altera nada no servidor remoto.`;

/** Executa a tool e traduz o resultado/erros para CallToolResult. Nunca lança. */
export async function handleFetchMarkdown(input: ToolInput): Promise<CallToolResult> {
  try {
    const page = await runPipeline(input);
    // Falha ao gravar não derruba a conversão: o texto ainda volta ao Claude.
    let savedPath: string | null = null;
    try {
      savedPath = await saveConversion(page.document, page.url, input.mode);
    } catch (saveErr) {
      console.error("[web2md] não foi possível salvar a conversão:", saveErr);
    }
    return {
      content: [{ type: "text", text: page.text }],
      structuredContent: {
        url: page.url,
        source: page.source,
        total_chars: page.total_chars,
        next_start_index: page.next_start_index,
        saved_path: savedPath,
      },
    };
  } catch (err) {
    return errorResult(err);
  }
}

export function errorResult(err: unknown): CallToolResult {
  if (err instanceof Web2mdError) {
    return { isError: true, content: [{ type: "text", text: err.message }] };
  }
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[web2md] erro inesperado:", err);
  return { isError: true, content: [{ type: "text", text: `Erro inesperado: ${detail}` }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    TOOL_NAME,
    {
      title: TOOL_TITLE,
      description: TOOL_DESCRIPTION,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: {
        title: TOOL_TITLE,
        // Não altera o servidor remoto, mas grava o Markdown em disco local.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => handleFetchMarkdown(args),
  );

  return server;
}

function main(): void {
  // Logs SEMPRE em stderr: stdout pertence ao protocolo MCP.
  process.on("uncaughtException", (err) => console.error("[web2md] uncaughtException:", err));
  process.on("unhandledRejection", (err) => console.error("[web2md] unhandledRejection:", err));
  serveStdio(() => createServer(), {
    onerror: (err) => console.error("[web2md] erro de transporte:", err),
  });
  console.error(`[web2md] ${SERVER_NAME} ${SERVER_VERSION} pronto (stdio)`);
}

/** Só inicia o servidor quando este arquivo é o ponto de entrada (não ao ser importado por testes). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
