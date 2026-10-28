import * as z from "zod/v4";
import { DEFAULT_MAX_CHARS } from "../constants.js";

export const MIN_MAX_CHARS = 100;
export const MAX_MAX_CHARS = 500_000;

/** Validador de URL http(s) compartilhado pela tool de URL única e pela de lote. */
export const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "A URL deve começar com http:// ou https://",
  });

export const InputSchema = z
  .object({
    url: httpUrl.describe(
        "URL absoluta http:// ou https:// da página a converter. Exemplo: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table",
      ),
    mode: z
      .enum(["article", "full", "outline"])
      .default("article")
      .describe(
        'Modo de extração. "article" (padrão) devolve só o conteúdo principal, sem menu, rodapé ou barra lateral. "full" converte o <body> inteiro; use se "article" devolver pouco conteúdo ou o conteúdo errado. "outline" converte como "article", mas devolve só o índice de headings (nível, texto, slug, offset e tamanho de cada seção) para economizar contexto; depois leia a seção desejada com o parâmetro section. O texto do índice respeita max_chars: se não couber, mostra só os primeiros headings e termina com um aviso de truncamento.',
      ),
    max_chars: z
      .number()
      .int()
      .min(MIN_MAX_CHARS)
      .max(MAX_MAX_CHARS)
      .default(DEFAULT_MAX_CHARS)
      .describe(
        `Máximo de caracteres por resposta (${MIN_MAX_CHARS}–${MAX_MAX_CHARS}, padrão ${DEFAULT_MAX_CHARS}). Se o documento for maior, a resposta termina com um marcador indicando o start_index da continuação. Com mode="outline" limita o tamanho do índice (que não é paginado): o que não couber é omitido, com um aviso no fim.`,
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
    section: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Devolve só uma seção do documento convertido: o heading e tudo até o próximo heading de nível igual ou menor (subseções incluídas). Aceita o slug do heading (ver mode="outline"), o texto do heading (sem diferenciar caixa/acentos; prefixo ou trecho vale se for unívoco) ou o id HTML. Sem section, o fragmento "#x" da URL é usado se casar com um heading. max_chars/start_index paginam dentro da seção. Seção inexistente ou ambígua devolve erro listando os headings disponíveis. Com mode="outline", restringe o índice a essa seção.',
      ),
    return_content: z
      .boolean()
      .default(true)
      .describe(
        'Se true (padrão), devolve o Markdown completo no contexto do modelo com paginação via max_chars/start_index. Se false, salva o arquivo em disco e devolve apenas metadados (url, título, tamanho, caminho) — útil para fetch em lote ou quando o conteúdo será lido depois por uma ferramenta de arquivo.',
      ),
  })
  .strict();

/** Heading/seção no structuredContent. Offsets em caracteres do documento completo salvo (frontmatter incluído). */
export const HeadingSchema = z.object({
  heading: z.string().describe("Texto do heading."),
  level: z.number().int().describe("Nível do heading (1–6)."),
  slug: z.string().describe("Slug estável e único no documento; use em section."),
  id: z.string().nullable().describe("Id HTML original do heading, se houver."),
  start: z.number().int().describe("Offset inicial da seção no documento completo."),
  end: z.number().int().describe("Offset final (exclusivo) da seção: até o próximo heading de nível igual ou menor."),
  chars: z.number().int().describe("Tamanho da seção (end - start)."),
});

export type InputType = z.infer<typeof InputSchema>;

/** Contrato do structuredContent devolvido pela tool. */
export const OutputSchema = z.object({
  url: z.string().describe("URL final, depois de redirects."),
  source: z.enum(["html", "native-markdown"]).describe("Origem do Markdown."),
  total_chars: z
    .number()
    .int()
    .describe(
      "Tamanho total (em caracteres) do texto que é paginado por start_index: o documento completo ou, com section, o documento da seção (frontmatter + seção). Com mode=\"outline\", o tamanho do documento completo.",
    ),
  document_chars: z
    .number()
    .int()
    .describe("Tamanho do documento completo salvo em disco (frontmatter + corpo), com ou sem section/outline."),
  section: HeadingSchema.nullable().describe("A seção devolvida (com section ou fragmento da URL); null caso contrário."),
  headings: z
    .array(HeadingSchema)
    .nullable()
    .describe(
      'Lista estruturada de headings com mode="outline" (e return_content=true); null caso contrário. Limitada a 500 itens (veja headings_truncated), independentemente de max_chars.',
    ),
  headings_truncated: z
    .boolean()
    .describe("true se headings foi cortada em 500 itens (a página tem mais headings do que os listados); false caso contrário."),
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
