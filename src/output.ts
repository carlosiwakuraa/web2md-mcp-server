import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_SAVED_DOC_BYTES,
  OUTPUT_DIR_ENV,
  RETENTION_DAYS_ENV,
} from "./constants.js";
import { effectiveEnv } from "./env.js";
import type { Mode } from "./types.js";

const MAX_SLUG_CHARS = 100;
/** Hex do SHA-256 no nome do arquivo: 64 bits. */
const HASH_HEX_CHARS = 16;
/** Temporário de gravação que sobrou (processo morto) é descartado após esse tempo. */
const STALE_TEMP_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Nome dos nossos arquivos (e dos temporários `.tmp-<hex>`): a limpeza só toca nesse padrão. */
const OWN_FILE_RE = /^[A-Za-z0-9._-]*-[0-9a-f]{16}(?:\.full)?\.md(\.tmp-[0-9a-f]{12})?$/;

const isWindows = process.platform === "win32";

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Identificador do usuário atual para o nome da pasta: uid (POSIX) ou nome de usuário. */
function userTag(): string {
  const uid = currentUid();
  if (uid !== undefined) return String(uid);
  let name = "user";
  try {
    name = os.userInfo().username || name;
  } catch {
    // sem entrada de usuário: mantém o genérico.
  }
  return name.replace(/[^A-Za-z0-9._-]+/g, "_") || "user";
}

/** `XDG_RUNTIME_DIR` só vale se for absoluto, existir como diretório real, do usuário e sem acesso de grupo/outros. */
function validRuntimeDir(value: string | undefined): string | undefined {
  const dir = effectiveEnv(value);
  if (!dir || isWindows || !path.isAbsolute(dir)) return undefined;
  try {
    const st = lstatSync(dir);
    const uid = currentUid();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) return undefined;
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Pasta padrão, por usuário: `$XDG_RUNTIME_DIR/web2md` (se válida) ou `<tmpdir>/web2md-<uid|usuário>`.
 * Antes era `<tmpdir>/web2md`, previsível e compartilhada entre usuários no Linux.
 */
export function defaultOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = validRuntimeDir(env.XDG_RUNTIME_DIR);
  if (runtime) return path.join(runtime, "web2md");
  return path.join(os.tmpdir(), `web2md-${userTag()}`);
}

/** Expande `~` no início (`~`, `~/x`, `~\x`); `~usuario` não é suportado e segue como caminho relativo. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Pasta de saída: `WEB2MD_OUTPUT_DIR` (com `~` expandido) ou a pasta padrão por usuário.
 * Não lança: um valor relativo é devolvido como está e a gravação falha com erro claro
 * (ver `prepareOutputDir`), em vez de depender do cwd do cliente.
 */
export function resolveOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = effectiveEnv(env[OUTPUT_DIR_ENV]);
  if (custom) {
    const expanded = expandHome(custom);
    return path.isAbsolute(expanded) ? path.resolve(expanded) : expanded;
  }
  return defaultOutputDir(env);
}

/**
 * Nome de arquivo estável para a conversão: `<host>_<caminho>-<hash>[.full].md`.
 * O hash são os 16 primeiros hex (64 bits) do SHA-256 da URL inteira (com query). Não é garantia
 * absoluta de unicidade: colisão acidental é improvável (~2^-33 com 2^16 URLs), mas não impossível.
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
  const hash = createHash("sha256").update(pageUrl).digest("hex").slice(0, HASH_HEX_CHARS);
  const suffix = mode === "full" ? ".full" : "";
  return `${slug || "pagina"}-${hash}${suffix}.md`;
}

const warnedDirs = new Set<string>();
const cleanedDirs = new Set<string>();

/**
 * Cria (0700) e valida a pasta de saída.
 * - Pasta padrão (`strict`): precisa ser diretório real (não link), do uid atual; se estiver aberta a
 *   grupo/outros, corrige para 0700. Caso contrário recusa, e nada é gravado.
 * - Pasta escolhida pelo usuário: exige caminho absoluto e diretório; permissões abertas só geram um aviso.
 */
export async function prepareOutputDir(dir: string, strict: boolean): Promise<void> {
  if (!path.isAbsolute(dir)) {
    throw new Error(
      `${OUTPUT_DIR_ENV} deve ser um caminho absoluto (ou começar com ~): recebido "${dir}". Corrija o valor; a conversão não foi gravada.`,
    );
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const uid = currentUid();
  if (strict) {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`A pasta de saída ${dir} é um link simbólico; recusei gravar nela. Remova-a ou defina ${OUTPUT_DIR_ENV}.`);
    }
    if (!st.isDirectory()) {
      throw new Error(`A pasta de saída ${dir} existe mas não é um diretório. Remova-a ou defina ${OUTPUT_DIR_ENV}.`);
    }
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(
        `A pasta de saída ${dir} pertence a outro usuário (uid ${st.uid}); recusei gravar nela. Defina ${OUTPUT_DIR_ENV} para uma pasta sua.`,
      );
    }
    if (!isWindows && (st.mode & 0o077) !== 0) await chmod(dir, 0o700);
    return;
  }
  const st = await stat(dir);
  if (!st.isDirectory()) throw new Error(`${OUTPUT_DIR_ENV} aponta para algo que não é um diretório: ${dir}.`);
  if (!isWindows && (st.mode & 0o077) !== 0 && !warnedDirs.has(dir)) {
    warnedDirs.add(dir);
    console.error(
      `[web2md] aviso: a pasta de saída ${dir} é acessível a outros usuários (modo ${(st.mode & 0o777).toString(8)}); o conteúdo salvo pode ser lido por eles. Considere chmod 700.`,
    );
  }
}

/** Dias de retenção: `WEB2MD_RETENTION_DAYS` (0 desativa) ou o padrão; valor inválido cai no padrão. */
function retentionDays(env: NodeJS.ProcessEnv): { days: number; explicit: boolean } {
  const raw = effectiveEnv(env[RETENTION_DAYS_ENV]);
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return { days: n, explicit: true };
  }
  return { days: DEFAULT_RETENTION_DAYS, explicit: false };
}

/**
 * Apaga arquivos nossos (nome no padrão `...-<16 hex>[.full].md` e temporários `.tmp-`) mais velhos que
 * `days` dias. Ignora tudo o que não segue o padrão, links e subpastas. `days <= 0` não faz nada.
 * Devolve quantos arquivos foram removidos.
 */
export async function cleanupOldFiles(dir: string, days: number, now: number = Date.now()): Promise<number> {
  if (!(days > 0)) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = OWN_FILE_RE.exec(name);
    if (!m) continue;
    const limit = m[1] ? Math.min(days * DAY_MS, STALE_TEMP_MS) : days * DAY_MS;
    const file = path.join(dir, name);
    try {
      const st = await lstat(file);
      if (!st.isFile() || now - st.mtimeMs <= limit) continue;
      await unlink(file);
      removed++;
    } catch {
      // sumiu ou sem permissão: segue.
    }
  }
  return removed;
}

/**
 * Limpeza oportunista, no máximo uma vez por processo e pasta. Na pasta padrão vale o padrão de 7 dias;
 * numa pasta escolhida pelo usuário só roda se `WEB2MD_RETENTION_DAYS` for definida explicitamente.
 */
async function cleanupOnce(dir: string, strict: boolean, env: NodeJS.ProcessEnv): Promise<void> {
  if (cleanedDirs.has(dir)) return;
  cleanedDirs.add(dir);
  const { days, explicit } = retentionDays(env);
  if (!strict && !explicit) return;
  try {
    await cleanupOldFiles(dir, days);
  } catch {
    // limpeza é melhor-esforço.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rename com poucas tentativas no Windows, onde substituir um arquivo aberto por um leitor falha com EPERM/EBUSY. */
async function renameReplace(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!isWindows || attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await sleep(25 * (attempt + 1));
    }
  }
}

/**
 * Grava de forma atômica: escreve em `<nome>.tmp-<aleatório>` (flags `wx`, 0600, sem seguir link),
 * fsync e `rename` sobre o destino, então um leitor concorrente nunca vê arquivo parcial. Recusa
 * destino que seja link ou não seja arquivo regular.
 */
async function writeFileAtomic(file: string, document: string): Promise<void> {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const fh = await open(tmp, flags, 0o600);
  try {
    try {
      await fh.writeFile(document, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      const st = await lstat(file);
      if (!st.isFile()) throw new Error(`o destino ${file} existe e não é um arquivo regular (link ou pasta); recusei sobrescrever.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await renameReplace(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Grava o documento completo (sem paginação) e devolve o caminho absoluto do arquivo. */
export async function saveConversion(
  document: string,
  pageUrl: string,
  mode: Mode,
  dir: string = resolveOutputDir(),
): Promise<string> {
  if (Buffer.byteLength(document, "utf8") > MAX_SAVED_DOC_BYTES) {
    throw new Error(
      `O documento excede o limite de ${Math.round(MAX_SAVED_DOC_BYTES / 1024 / 1024)} MB para gravação; não foi salvo.`,
    );
  }
  const strict = dir === defaultOutputDir();
  await prepareOutputDir(dir, strict);
  await cleanupOnce(dir, strict, process.env);
  const file = path.join(dir, outputFileName(pageUrl, mode));
  await writeFileAtomic(file, document);
  return file;
}
