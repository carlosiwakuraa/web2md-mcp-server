import * as z from "zod/v4";
import { DEFAULT_MAX_CHARS } from "../constants.js";

export const MIN_MAX_CHARS = 100;
export const MAX_MAX_CHARS = 500_000;

export const InputSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), {
        message: "A URL deve começar com http:// ou https://",
      })
      .describe(
        "URL absoluta http:// ou https:// da página a converter. Exemplo: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table",
      ),
    mode: z
      .enum(["article", "full"])
      .default("article")
      .describe(
        'Modo de extração. "article" (padrão) devolve só o conteúdo principal, sem menu, rodapé ou barra lateral. "full" converte o <body> inteiro; use se "article" devolver pouco conteúdo ou o conteúdo errado.',
      ),
    max_chars: z
      .number()
      .int()
      .min(MIN_MAX_CHARS)
      .max(MAX_MAX_CHARS)
      .default(DEFAULT_MAX_CHARS)
      .describe(
        `Máximo de caracteres por resposta (${MIN_MAX_CHARS}–${MAX_MAX_CHARS}, padrão ${DEFAULT_MAX_CHARS}). Se o documento for maior, a resposta termina com um marcador indicando o start_index da continuação.`,
      ),
    start_index: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Posição (em caracteres) do documento completo onde a resposta começa (padrão 0). Para páginas longas, use o valor indicado no marcador de truncamento da resposta anterior.",
      ),
    include_links: z
      .boolean()
      .default(false)
      .describe(
        'Se true, anexa ao final a seção "## Links da página" com todos os links do conteúdo convertido (texto e URL absoluta). Padrão false.',
      ),
    return_content: z
      .boolean()
      .default(true)
      .describe(
        'Se true (padrão), devolve o Markdown completo no contexto do modelo com paginação via max_chars/start_index. Se false, salva o arquivo em disco e devolve apenas metadados (url, título, tamanho, caminho) — útil para fetch em lote ou quando o conteúdo será lido depois por uma ferramenta de arquivo.',
      ),
  })
  .strict();

export type InputType = z.infer<typeof InputSchema>;

/** Contrato do structuredContent devolvido pela tool. */
export const OutputSchema = z.object({
  url: z.string().describe("URL final, depois de redirects."),
  source: z.enum(["html", "native-markdown"]).describe("Origem do Markdown."),
  total_chars: z.number().int().describe("Tamanho total (em caracteres) do documento completo, antes da paginação."),
  next_start_index: z
    .number()
    .int()
    .nullable()
    .describe("start_index para continuar a leitura, ou null se esta resposta chegou ao fim."),
  saved_path: z
    .string()
    .nullable()
    .describe("Caminho absoluto do arquivo .md com o documento completo salvo em disco, ou null se a gravação falhou."),
});
