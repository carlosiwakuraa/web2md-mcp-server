import TurndownService from "turndown";
import { registerAdmonitionRules } from "../rules/admonitions.js";
import { registerBlockRules } from "../rules/blocks.js";
import { registerEmbeddedRules } from "../rules/embedded.js";
import { registerInlineRules } from "../rules/inline.js";
import { registerMathRules } from "../rules/math.js";
import { registerTableRules } from "../rules/tables.js";
import { capWhitespaceRuns } from "../text-util.js";
import type { ConvertContext } from "../types.js";

/** Aplica `capWhitespaceRuns` a todos os nós de texto (o Turndown é quadrático em corridas enormes de espaço). */
function capTextNodes(root: Node): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        const t = child as Text;
        if (t.data.length > 256) {
          const capped = capWhitespaceRuns(t.data);
          if (capped !== t.data) t.data = capped;
        }
      } else if (child.nodeType === 1) {
        stack.push(child);
      }
    }
  }
}

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

  capTextNodes(root);
  return td.turndown(root as HTMLElement);
}
