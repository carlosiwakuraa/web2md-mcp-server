import TurndownService from "turndown";
import { registerAdmonitionRules } from "../rules/admonitions.js";
import { registerBlockRules } from "../rules/blocks.js";
import { registerEmbeddedRules } from "../rules/embedded.js";
import { registerInlineRules } from "../rules/inline.js";
import { registerMathRules } from "../rules/math.js";
import { registerTableRules } from "../rules/tables.js";
import type { ConvertContext } from "../types.js";

/** Etapa 5: instancia Turndown, registra as regras de rules/* e converte o nó. */
export function convertToMarkdown(root: Element, ctx: ConvertContext): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });

  // Regras registradas depois têm prioridade no Turndown.
  registerBlockRules(td, ctx);
  registerInlineRules(td, ctx);
  registerTableRules(td, ctx);
  registerEmbeddedRules(td, ctx);
  registerMathRules(td, ctx);
  registerAdmonitionRules(td, ctx);

  return td.turndown(root as HTMLElement);
}
