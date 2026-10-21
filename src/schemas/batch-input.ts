import * as z from "zod/v4";
import { DEFAULT_FILES_PER_AGENT, DEFAULT_INLINE_MAX_FILES, DEFAULT_MAX_CHARS, MAX_BATCH_URLS } from "../constants.js";
import { MAX_MAX_CHARS, MIN_MAX_CHARS } from "./input.js";

const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "A URL deve começar com http:// ou https://",
  });

export const BatchInputSchema = z
  .object({
    urls: z
      .array(httpUrl)
      .min(1)
      .max(MAX_BATCH_URLS)
      .describe(`Lista de URLs http:// ou https:// a converter (1–${MAX_BATCH_URLS}). URLs repetidas são convertidas uma única vez.`),
    mode: z
      .enum(["article", "full"])
      .default("article")
      .describe('Modo de extração aplicado a todas as URLs. "article" (padrão) devolve só o conteúdo principal; "full" converte o <body> inteiro.'),
    include_links: z
      .boolean()
      .default(false)
      .describe('Se true, anexa a seção "## Links da página" em cada documento. Padrão false.'),
    return_content: z
      .boolean()
      .default(true)
      .describe(
        "Se false, salva todos os .md em disco e devolve só o manifesto: nada do conteúdo vai ao contexto. Se true (padrão), o conteúdo vem ao contexto quando a quantidade de arquivos convertidos é pequena (inline_max_files); acima disso, NÃO vem ao contexto principal e a resposta traz um plano para invocar subagentes.",
      ),
    inline_max_files: z
      .number()
      .int()
      .min(1)
      .max(MAX_BATCH_URLS)
      .default(DEFAULT_INLINE_MAX_FILES)
      .describe(`Com return_content=true, quantidade máxima de arquivos convertidos que ainda vêm inline no contexto (padrão ${DEFAULT_INLINE_MAX_FILES}). Acima disso, a resposta é um plano de subagentes.`),
    files_per_agent: z
      .number()
      .int()
      .min(1)
      .max(MAX_BATCH_URLS)
      .default(DEFAULT_FILES_PER_AGENT)
      .describe(`No plano de subagentes, quantidade de arquivos por subagente (padrão ${DEFAULT_FILES_PER_AGENT}; 1 = um subagente por arquivo).`),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe("O que o usuário quer das páginas (ex.: 'comparar as opções de autenticação'). É repassado aos subagentes do plano para guiar a extração."),
    max_chars: z
      .number()
      .int()
      .min(MIN_MAX_CHARS)
      .max(MAX_MAX_CHARS)
      .default(DEFAULT_MAX_CHARS)
      .describe(`Só no modo inline: máximo de caracteres de cada documento no contexto (padrão ${DEFAULT_MAX_CHARS}). O arquivo salvo é sempre completo.`),
  })
  .strict();

export type BatchInput = z.infer<typeof BatchInputSchema>;

export const BatchItemSchema = z.object({
  url: z.string().describe("URL pedida."),
  final_url: z.string().nullable().describe("URL final depois de redirects, ou null em caso de erro."),
  slug: z.string().describe("Identificador estável do arquivo (nome sem .md). Use como nome do subagente."),
  status: z.enum(["ok", "error"]),
  title: z.string().nullable(),
  source: z.enum(["html", "native-markdown"]).nullable(),
  total_chars: z.number().int().nullable().describe("Tamanho do documento completo salvo."),
  saved_path: z.string().nullable().describe("Caminho absoluto do .md salvo, ou null."),
  error: z.string().nullable(),
});

export const BatchGroupSchema = z.object({
  agent_name: z.string().describe("Nome sugerido para o subagente."),
  files: z.array(z.object({ slug: z.string(), url: z.string(), saved_path: z.string() })),
});

export const BatchOutputSchema = z.object({
  dispatch: z
    .enum(["saved", "inline", "subagents"])
    .describe('"saved": só salvo em disco; "inline": conteúdo no texto da resposta; "subagents": conteúdo NÃO está no contexto, siga o plano em groups.'),
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  output_dir: z.string(),
  objective: z.string().nullable(),
  items: z.array(BatchItemSchema),
  groups: z.array(BatchGroupSchema).describe("Plano de subagentes; vazio quando dispatch != subagents."),
});
