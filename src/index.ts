#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BATCH_CONCURRENCY, BATCH_DEADLINE_MS, BATCH_TOOL_NAME, DEFAULT_FILES_PER_AGENT, DEFAULT_INLINE_MAX_FILES, MAX_BATCH_URLS, OUTPUT_DIR_ENV, SERVER_NAME, SERVER_VERSION, TOOL_NAME } from "./constants.js";
import { handleBatch } from "./batch.js";
import { Web2mdError } from "./errors.js";
import { saveConversion } from "./output.js";
import { conversionMode, runPipeline, urlFragment } from "./pipeline.js";
import { BatchInputSchema, BatchOutputSchema } from "./schemas/batch-input.js";
import { InputSchema, OutputSchema } from "./schemas/input.js";
import type { ToolInput } from "./types.js";

const TOOL_TITLE = "Converter página web em Markdown";

const TOOL_DESCRIPTION = `Busca uma URL a partir da máquina local e devolve o conteúdo da página como Markdown (GFM) fiel à estrutura original: títulos, listas, tabelas, blocos de código com linguagem, links e imagens com URLs absolutas, avisos (> [!NOTE]) e fórmulas ($...$).

Parâmetros:
- url (obrigatório): URL http:// ou https:// da página.
- mode: "article" (padrão) extrai só o conteúdo principal (main/article, sem menu, rodapé e barra lateral). Use "full" para converter o <body> inteiro quando "article" devolver pouco conteúdo ou o conteúdo errado. Use "outline" para ler só o índice de headings da página (converte como "article"): economiza contexto em páginas longas; depois peça a seção desejada com section.
- section: devolve só uma seção do documento convertido, em vez da página inteira. Aceita o slug do heading (veja o outline), o texto do heading (sem diferenciar maiúsculas/acentos; prefixo ou trecho serve se for unívoco) ou o id HTML. A seção inclui o heading e tudo até o próximo heading de nível igual ou menor (subseções entram). Se section não for informado, o fragmento da URL (https://site/pagina#instalacao) é usado quando casar com um heading; se não casar, é ignorado e a página inteira é devolvida. Seção inexistente ou ambígua é erro e lista os headings disponíveis.
- max_chars: limite de caracteres por resposta (padrão 50000). Não se aplica a mode="outline".
- start_index: posição do documento onde a resposta começa (padrão 0), para paginar. Com section, a posição é dentro da seção. Não se aplica a mode="outline".
- include_links: se true, anexa a seção "## Links da página" com todos os links do conteúdo.
- return_content: se false, não devolve o Markdown no contexto; salva em disco e retorna só metadados (url, título, chars, caminho). Padrão true.

Retorno: texto Markdown com um frontmatter YAML (url, canonical, title, description, lang, fetched_at, source), seguido do corpo com um único H1. Se o servidor responder com Markdown nativo, ele é devolvido diretamente (source: native-markdown). O structuredContent traz { url, source, total_chars, document_chars, next_start_index, saved_path, section, headings }.

Outline: com mode="outline" a resposta é o frontmatter (com mode: outline) mais uma lista hierárquica dos headings, cada um com nível, texto, slug estável e offset inicial–final (em caracteres do documento completo, frontmatter incluído) e tamanho da seção; headings no structuredContent traz a mesma lista estruturada ({ heading, level, slug, id, start, end, chars }) e total_chars o tamanho do documento completo. Fluxo para economizar contexto: chame com mode="outline", escolha o slug e chame de novo com section="<slug>". Com section junto de outline, o índice se restringe àquela seção.

Seção: com section (ou fragmento da URL) o texto é o frontmatter (com os campos section e section_slug) mais só a seção; total_chars e a paginação (max_chars/start_index/next_start_index) valem para esse documento da seção, e section no structuredContent descreve o heading escolhido. Blocos de código nunca são cortados nem confundem a detecção de headings. document_chars é sempre o tamanho do documento completo salvo.

Salvamento: toda conversão bem-sucedida é gravada na pasta temporária do sistema em web2md/ (ou em WEB2MD_OUTPUT_DIR, se definida), sempre com o documento completo, independentemente de max_chars/start_index/section/outline (o modo outline grava no mesmo arquivo do modo article, que tem o mesmo conteúdo). saved_path traz o caminho absoluto do arquivo (null se a gravação falhar). Reconverter a mesma URL e modo sobrescreve o arquivo.

Paginação: se o documento passar de max_chars, a resposta termina com o marcador "[Conteúdo truncado: exibidos caracteres X–Y de TOTAL. Para continuar, chame novamente com start_index=N]" (e next_start_index no structuredContent). Chame de novo com o mesmo url/mode e start_index=N para ler o restante; o frontmatter só aparece na primeira parte. Um start_index além do fim do documento é um erro.

Erros (isError, com mensagem descritiva): URL inválida; Erro HTTP 4xx/5xx; timeout (30 s); falha de rede; content-type não suportado (só HTML e Markdown; PDFs e imagens não são convertidos); página vazia após a extração (tente mode="full"); página que depende de JavaScript para renderizar (não há execução de JS). Não altera nada no servidor remoto.`;

const BATCH_TOOL_TITLE = "Converter várias páginas web em Markdown (lote)";

const BATCH_TOOL_DESCRIPTION = `Converte várias URLs (até ${MAX_BATCH_URLS}) em Markdown (GFM) numa única chamada, com a mesma conversão da tool ${TOOL_NAME}, e salva cada página em um arquivo .md. Use quando o usuário pedir para ler, comparar ou resumir várias páginas de uma vez.

COMPORTAMENTO POR QUANTIDADE DE ARQUIVOS (campo dispatch na resposta):
1) return_content=false -> dispatch "saved": tudo é salvo em disco e a resposta traz só o manifesto (url, título, chars, caminho de cada arquivo). Nenhum conteúdo vai ao contexto.
2) return_content=true (padrão) e até inline_max_files arquivos convertidos (padrão ${DEFAULT_INLINE_MAX_FILES}) -> dispatch "inline": o Markdown de cada página vem no texto da resposta (cada documento limitado por max_chars) e o manifesto no structuredContent.
3) return_content=true e MAIS que inline_max_files arquivos convertidos -> dispatch "subagents": o conteúdo NÃO vem ao contexto principal. A resposta traz o manifesto e um plano em groups, com files_per_agent arquivos por subagente (padrão ${DEFAULT_FILES_PER_AGENT}; 1 = um subagente por arquivo). Cada grupo tem agent_name e a lista de arquivos (slug, url, saved_path).

REGRA OBRIGATÓRIA ao receber dispatch "subagents": NÃO leia os arquivos .md no contexto principal. Invoque um subagente por grupo (em paralelo, na mesma mensagem) usando o agent_name indicado, repassando o objective da resposta (ou o pedido do usuário, se objective for null) e os saved_path do grupo. Cada subagente deve ler somente os arquivos do seu grupo e devolver uma extração objetiva e curta, não o documento inteiro. Depois, sintetize as extrações para o usuário. Se o cliente não suportar subagentes, avise o usuário em vez de ler os arquivos no contexto principal (ou peça para repetir com return_content=false e inline_max_files maior, ciente do custo de contexto).

Parâmetros:
- urls (obrigatório): 1 a ${MAX_BATCH_URLS} URLs http:// ou https://. URLs repetidas são convertidas uma única vez (deduplicação); o fragmento "#..." é removido antes de comparar, então URLs que só diferem pelo fragmento contam como uma só.
- mode: "article" (padrão) extrai só o conteúdo principal; "full" converte o <body> inteiro. Vale para todas as URLs.
- include_links: se true, anexa "## Links da página" em cada documento. Padrão false.
- return_content: veja o comportamento acima. Padrão true.
- inline_max_files: limite de arquivos convertidos que ainda vêm inline (padrão ${DEFAULT_INLINE_MAX_FILES}).
- files_per_agent: arquivos por subagente no plano (padrão ${DEFAULT_FILES_PER_AGENT}).
- objective: o que o usuário quer das páginas (ex.: "comparar as opções de autenticação"). Informe sempre que souber: é repassado aos subagentes para guiar a extração.
- Sem outline/section: o lote sempre converte e devolve documentos inteiros (o fragmento "#..." das URLs é descartado). Para índice de headings ou uma seção, use a tool ${TOOL_NAME} em cada URL.
- max_chars: só no modo inline, máximo de caracteres de cada documento no contexto (padrão 50000). Um documento maior termina com um marcador que aponta para o arquivo salvo completo; o lote não tem start_index, então para ler o restante leia o saved_path.

Execução: as URLs são buscadas com concorrência ${BATCH_CONCURRENCY}. A falha de uma URL não derruba as demais: cada item do manifesto tem status "ok" ou "error" (com a mensagem). isError só é true quando TODAS as URLs falham. Só arquivos com status "ok" entram no plano de subagentes. Falha ao salvar o arquivo conta como erro daquele item: nenhum item fica "ok" sem arquivo salvo.

Prazo global: o lote tem prazo de ${BATCH_DEADLINE_MS / 1000} s. URLs não concluídas até lá viram erro "Prazo do lote ... esgotado" e o resultado parcial é devolvido; os arquivos já salvos permanecem.

Salvamento: cada página convertida é gravada como <host>_<caminho>-<hash>[.full].md (o slug é o nome sem .md) na pasta temporária do sistema em web2md/ (ou em ${OUTPUT_DIR_ENV}, se definida); output_dir na resposta traz a pasta. O arquivo salvo é sempre o documento completo. URLs que convergem para o mesmo arquivo final (mesmo nome) contam como um só arquivo. Reconverter a mesma URL e modo sobrescreve o arquivo.

Retorno: texto (manifesto, conteúdo inline ou plano de subagentes, conforme dispatch) e structuredContent { dispatch, total, succeeded, failed, output_dir, objective, items, groups }. Não altera nada nos servidores remotos.`;

const SERVER_INSTRUCTIONS = `A tool ${BATCH_TOOL_NAME} converte várias URLs em Markdown. Quando ela responder com dispatch "subagents", o conteúdo das páginas NÃO está no contexto: ele está salvo em arquivos.
Delegue a leitura aos subagentes conforme o plano em groups (um subagente por grupo, em paralelo, repassando o objective) e não leia esses arquivos no contexto principal.`;

function compactSummary(
  url: string,
  title: string | undefined,
  chars: number,
  savedPath: string | null,
  extra: string[] = [],
): string {
  const lines = ['Conversão concluída.', ''];
  lines.push(`url: ${url}`);
  if (title) lines.push(`title: ${title}`);
  lines.push(`chars: ${chars.toLocaleString('pt-BR')}`);
  lines.push(...extra);
  lines.push(`saved: ${savedPath ?? '(falha ao salvar)'}`);
  return lines.join('\n');
}

/** Executa a tool e traduz o resultado/erros para CallToolResult. Nunca lança. */
export async function handleFetchMarkdown(input: ToolInput): Promise<CallToolResult> {
  try {
    const fragment = urlFragment(input.url);
    const page = await runPipeline(fragment === undefined ? input : { ...input, fragment });
    // Falha ao gravar não derruba a conversão: o texto ainda volta ao Claude.
    let savedPath: string | null = null;
    try {
      // O arquivo é sempre o documento completo; outline salva no mesmo arquivo de "article" (mesmo conteúdo).
      savedPath = await saveConversion(page.document, page.url, conversionMode(input.mode));
    } catch (saveErr) {
      console.error("[web2md] não foi possível salvar a conversão:", saveErr);
    }
    const extra: string[] = [];
    if (page.section) extra.push(`section: ${page.section.slug} (${page.section.chars.toLocaleString('pt-BR')} chars)`);
    if (page.headings) extra.push(`headings: ${page.headings.length}`);
    const text = input.return_content
      ? page.text
      : compactSummary(page.url, page.title, page.document_chars, savedPath, extra);
    const next_start_index = input.return_content ? page.next_start_index : null;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        url: page.url,
        source: page.source,
        total_chars: input.return_content ? page.total_chars : page.document_chars,
        document_chars: page.document_chars,
        section: page.section,
        headings: input.return_content ? page.headings : null,
        next_start_index,
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
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

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

  server.registerTool(
    BATCH_TOOL_NAME,
    {
      title: BATCH_TOOL_TITLE,
      description: BATCH_TOOL_DESCRIPTION,
      inputSchema: BatchInputSchema,
      outputSchema: BatchOutputSchema,
      annotations: {
        title: BATCH_TOOL_TITLE,
        // Não altera os servidores remotos, mas grava os Markdown em disco local.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => handleBatch(args),
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
