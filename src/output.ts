import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OUTPUT_DIR_ENV } from "./constants.js";
import { effectiveEnv } from "./env.js";
import type { Mode } from "./types.js";

const MAX_SLUG_CHARS = 100;

/** Pasta de saída: `WEB2MD_OUTPUT_DIR` se definida, senão `<tmpdir>/web2md`. */
export function resolveOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = effectiveEnv(env[OUTPUT_DIR_ENV]);
  if (custom) return path.resolve(custom);
  return path.join(os.tmpdir(), "web2md");
}

/**
 * Nome de arquivo estável para a conversão: `<host>_<caminho>-<hash>[.full].md`.
 * O hash cobre a URL inteira (com query), então URLs distintas nunca colidem.
 */
export function outputFileName(pageUrl: string, mode: Mode): string {
  let slug = pageUrl;
  try {
    const u = new URL(pageUrl);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // percent-encoding malformado: segue com o caminho cru.
    }
    slug = `${u.hostname}${pathname}`;
  } catch {
    // URL já validada pelo schema; o fallback só evita lançar aqui.
  }
  slug = slug
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9.-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/_+$/, "");
  const hash = createHash("sha256").update(pageUrl).digest("hex").slice(0, 8);
  const suffix = mode === "full" ? ".full" : "";
  return `${slug || "pagina"}-${hash}${suffix}.md`;
}

/** Grava o documento completo (sem paginação) e devolve o caminho absoluto do arquivo. */
export async function saveConversion(
  document: string,
  pageUrl: string,
  mode: Mode,
  dir: string = resolveOutputDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, outputFileName(pageUrl, mode));
  await writeFile(file, document, "utf8");
  return file;
}
