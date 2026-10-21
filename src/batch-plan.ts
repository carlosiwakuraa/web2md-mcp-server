/** Planejamento do lote (v1.2): funções puras, sem I/O. */
import { basename } from "node:path";
import type { BatchDispatch, BatchGroup, BatchItem, BatchStructured, InlineDoc } from "./batch-types.js";

const MAX_AGENT_NAME = 60;

export function slugFromFileName(fileName: string): string {
  return basename(fileName).replace(/\.md$/, "");
}

export function decideDispatch(okCount: number, returnContent: boolean, inlineMaxFiles: number): BatchDispatch {
  if (!returnContent || okCount === 0) return "saved";
  return okCount <= inlineMaxFiles ? "inline" : "subagents";
}

export function planGroups(items: BatchItem[], filesPerAgent: number): BatchGroup[] {
  const ok = items.filter((item) => item.status === "ok" && item.saved_path !== null);
  const size = Math.max(1, Math.floor(filesPerAgent));
  const groups: BatchGroup[] = [];
  for (let i = 0; i < ok.length; i += size) {
    const files = ok.slice(i, i + size).map((item) => ({
      slug: item.slug,
      url: item.final_url ?? item.url,
      saved_path: item.saved_path as string,
    }));
    const agent_name = files.length === 1 ? files[0].slug.slice(0, MAX_AGENT_NAME) : `web2md-lote-${groups.length + 1}`;
    groups.push({ agent_name, files });
  }
  return groups;
}

function failureLines(items: BatchItem[]): string[] {
  return items.filter((item) => item.status === "error").map((item) => `- ${item.url} — erro: ${item.error ?? "desconhecido"}`);
}

function renderSaved(result: BatchStructured): string {
  const lines = [
    `Lote concluído: ${result.succeeded} de ${result.total} URLs convertidas. Nada foi trazido ao contexto; os arquivos estão em ${result.output_dir}.`,
    "",
  ];
  for (const item of result.items) {
    if (item.status === "ok") {
      const title = item.title ? ` — ${item.title}` : "";
      lines.push(`- ${item.slug}${title} — ${item.total_chars ?? 0} chars — ${item.saved_path}`);
    } else {
      lines.push(`- ${item.url} — erro: ${item.error ?? "desconhecido"}`);
    }
  }
  return lines.join("\n");
}

function renderInline(result: BatchStructured, inlineDocs: InlineDoc[]): string {
  const head = [`Lote concluído: ${result.succeeded} de ${result.total} URLs convertidas (conteúdo inline abaixo).`];
  const failures = failureLines(result.items);
  if (failures.length > 0) head.push("", "URLs que falharam:", ...failures);
  const docs = inlineDocs.map((doc) => `## ${doc.slug}\nfonte: ${doc.url}\n\n${doc.text}`);
  return [head.join("\n"), ...docs].join("\n\n---\n\n");
}

function renderSubagents(result: BatchStructured): string {
  const lines = [
    "ATENÇÃO: o conteúdo convertido NÃO está neste contexto e NÃO deve ser lido aqui.",
    "",
    `Lote concluído: ${result.succeeded} de ${result.total} URLs convertidas. São ${result.succeeded} arquivos, mais que o limite inline; por isso foram salvos em disco (${result.output_dir}) e nada foi trazido ao contexto.`,
    "",
    "Não leia os arquivos no contexto principal. Invoque um subagente por grupo abaixo, em paralelo, usando o agent_name indicado. Cada subagente deve ler (Read) apenas os arquivos do seu grupo e devolver uma extração objetiva — pontos-chave, trechos relevantes e a fonte (URL e caminho do arquivo) —, sem copiar o documento inteiro.",
    "",
    result.objective
      ? `Objetivo do usuário (repasse a cada subagente): ${result.objective}`
      : "Nenhum objetivo foi informado: peça a cada subagente um resumo estruturado do(s) seu(s) arquivo(s).",
    "",
    "Grupos:",
  ];
  for (const group of result.groups) {
    lines.push("", `Subagente "${group.agent_name}":`);
    for (const file of group.files) lines.push(`- ${file.slug} — ${file.url} — ${file.saved_path}`);
  }
  const failures = failureLines(result.items);
  if (failures.length > 0) lines.push("", "URLs que falharam:", ...failures);
  lines.push("", "Se este cliente não suportar subagentes, avise o usuário em vez de ler os arquivos no contexto principal (ou peça para repetir com return_content=false e inline_max_files maior, ciente do custo de contexto).");
  return lines.join("\n");
}

export function renderBatchText(result: BatchStructured, inlineDocs: InlineDoc[]): string {
  switch (result.dispatch) {
    case "inline":
      return renderInline(result, inlineDocs);
    case "subagents":
      return renderSubagents(result);
    default:
      return renderSaved(result);
  }
}
