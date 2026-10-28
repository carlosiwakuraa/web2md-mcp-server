import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  cleanupOldFiles,
  defaultOutputDir,
  outputFileName,
  prepareOutputDir,
  resolveOutputDir,
  saveConversion,
} from "../src/output.js";

const tmp = mkdtempSync(path.join(tmpdir(), "web2md-output-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const posix = process.platform !== "win32";
const DEFAULT_RE = /web2md-[A-Za-z0-9._-]+$/;

describe("outputFileName", () => {
  it("monta host + caminho + hash, só com caracteres seguros", () => {
    const name = outputFileName("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table", "article");
    expect(name).toMatch(/^developer\.mozilla\.org_en-US_docs_Web_HTML_Element_table-[0-9a-f]{16}\.md$/);
  });

  it("é estável para a mesma URL e distingue query e modo", () => {
    const a = outputFileName("https://exemplo.com/p?id=1", "article");
    expect(outputFileName("https://exemplo.com/p?id=1", "article")).toBe(a);
    expect(outputFileName("https://exemplo.com/p?id=2", "article")).not.toBe(a);
    expect(outputFileName("https://exemplo.com/p?id=1", "full")).toMatch(/\.full\.md$/);
  });

  it("trata raiz, acentos e caminhos longos", () => {
    expect(outputFileName("https://exemplo.com/", "article")).toMatch(/^exemplo\.com-[0-9a-f]{16}\.md$/);
    expect(outputFileName("https://exemplo.com/açaí/página", "article")).toMatch(/^exemplo\.com_acai_pagina-/);
    expect(outputFileName(`https://exemplo.com/${"a".repeat(500)}`, "article").length).toBeLessThan(140);
  });

  it("a colisão de 32 bits conhecida (?q=17012 x ?q=17226) não colide mais", () => {
    const a = outputFileName("https://exemplo.com/p?q=17012", "article");
    const b = outputFileName("https://exemplo.com/p?q=17226", "article");
    expect(a).not.toBe(b);
    // Os 8 primeiros hex ainda coincidem (prova de que o par era uma colisão de 32 bits)...
    expect(a.match(/-([0-9a-f]{8})/)?.[1]).toBe(b.match(/-([0-9a-f]{8})/)?.[1]);
    // ...mas os 16 hex diferem.
  });
});

describe("resolveOutputDir", () => {
  it("usa WEB2MD_OUTPUT_DIR quando definida", () => {
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: tmp })).toBe(tmp);
  });

  it("vazio, só espaços ou placeholder não resolvido caem no padrão", () => {
    for (const v of ["", "   ", "${user_config.output_dir}", "  ${user_config.output_dir} "]) {
      expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: v })).toBe(defaultOutputDir({}));
    }
  });

  it("valor válido é usado após trim", () => {
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: `  ${tmp}  ` })).toBe(tmp);
  });

  it("padrão: pasta por usuário em os.tmpdir()", () => {
    const dir = resolveOutputDir({});
    expect(path.dirname(dir)).toBe(tmpdir());
    expect(path.basename(dir)).toMatch(DEFAULT_RE);
    if (posix) expect(path.basename(dir)).toBe(`web2md-${process.getuid?.()}`);
  });

  it("expande ~ no início", () => {
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: "~" })).toBe(homedir());
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: "~/saida/md" })).toBe(path.join(homedir(), "saida", "md"));
  });

  it("caminho relativo não é resolvido contra o cwd", () => {
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: "saida/md" })).toBe("saida/md");
  });

  it.runIf(posix)("XDG_RUNTIME_DIR válido (0700, do usuário) é preferido; inválido é ignorado", () => {
    const rt = mkdtempSync(path.join(tmp, "xdg-"));
    expect(defaultOutputDir({ XDG_RUNTIME_DIR: rt })).toBe(path.join(rt, "web2md"));
    expect(defaultOutputDir({ XDG_RUNTIME_DIR: path.join(rt, "nao-existe") })).toBe(defaultOutputDir({}));
    expect(defaultOutputDir({ XDG_RUNTIME_DIR: "relativo" })).toBe(defaultOutputDir({}));
    const open = mkdtempSync(path.join(tmp, "xdg-open-"));
    // chmod explícito: independe da umask
    rmSync(open, { recursive: true });
    mkdirSync(open, { mode: 0o755 });
    expect(defaultOutputDir({ XDG_RUNTIME_DIR: open })).toBe(defaultOutputDir({}));
  });
});

describe("saveConversion", () => {
  it("cria a pasta (0700), grava o arquivo (0600) e sobrescreve numa reconversão", async () => {
    const dir = path.join(tmp, "nova", "pasta");
    const url = "https://exemplo.com/doc";
    const file = await saveConversion("# v1\n", url, "article", dir);
    expect(path.dirname(file)).toBe(dir);
    expect(readFileSync(file, "utf8")).toBe("# v1\n");
    if (posix) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const again = await saveConversion("# v2\n", url, "article", dir);
    expect(again).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("# v2\n");
    // nenhum temporário sobra
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("caminho relativo em WEB2MD_OUTPUT_DIR falha com erro claro e não grava", async () => {
    const dir = resolveOutputDir({ WEB2MD_OUTPUT_DIR: "saida-relativa" });
    await expect(saveConversion("x", "https://exemplo.com/", "article", dir)).rejects.toThrow(/caminho absoluto/);
    expect(existsSync(path.resolve("saida-relativa"))).toBe(false);
  });

  it.runIf(posix)("recusa destino que é link simbólico e não toca o alvo", async () => {
    const dir = mkdtempSync(path.join(tmp, "dest-link-"));
    const url = "https://exemplo.com/alvo";
    const alvo = path.join(tmp, "alvo-externo.txt");
    writeFileSync(alvo, "intocado");
    symlinkSync(alvo, path.join(dir, outputFileName(url, "article")));
    await expect(saveConversion("x", url, "article", dir)).rejects.toThrow(/não é um arquivo regular/);
    expect(readFileSync(alvo, "utf8")).toBe("intocado");
    expect(readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("recusa destino que é diretório", async () => {
    const dir = mkdtempSync(path.join(tmp, "dest-dir-"));
    const url = "https://exemplo.com/d";
    mkdirSync(path.join(dir, outputFileName(url, "article")));
    await expect(saveConversion("x", url, "article", dir)).rejects.toThrow(/não é um arquivo regular/);
  });

  it("recusa documento acima do teto sem gravar", async () => {
    const dir = mkdtempSync(path.join(tmp, "big-"));
    const spy = vi.spyOn(Buffer, "byteLength").mockReturnValueOnce(10 * 1024 * 1024 * 1024);
    try {
      await expect(saveConversion("x", "https://exemplo.com/g", "article", dir)).rejects.toThrow(/excede o limite/);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leitor concorrente nunca vê arquivo parcial ou vazio", async () => {
    const dir = mkdtempSync(path.join(tmp, "atomic-"));
    const url = "https://exemplo.com/grande";
    const docA = `A${"a".repeat(6 * 1024 * 1024)}`;
    const docB = `B${"b".repeat(3 * 1024 * 1024)}`;
    const file = await saveConversion(docA, url, "article", dir);
    let running = true;
    let reads = 0;
    const bad: number[] = [];
    const reader = (async () => {
      while (running) {
        try {
          const text = readFileSync(file, "utf8");
          reads++;
          if (text !== docA && text !== docB) bad.push(text.length);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          bad.push(-1); // o destino nunca deve sumir (rename é atômico)
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 20; i++) await saveConversion(i % 2 ? docA : docB, url, "article", dir);
    running = false;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

describe.runIf(posix)("pasta padrão: validação de dono, tipo e permissão", () => {
  // A pasta padrão fica sob os.tmpdir(); apontamos o tmpdir para uma pasta de teste isolada.
  const withTmpdir = async (fn: (dir: string) => Promise<void>) => {
    const base = mkdtempSync(path.join(tmp, "tmpdir-"));
    // XDG_RUNTIME_DIR (definido nos runners Linux) mudaria a pasta padrão real, então também é isolado.
    const old = process.env.TMPDIR;
    const oldRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.TMPDIR = base;
    delete process.env.XDG_RUNTIME_DIR;
    try {
      await fn(defaultOutputDir({}));
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
      if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRuntime;
    }
  };

  it("cria a pasta com 0700 e grava nela", async () => {
    await withTmpdir(async (dir) => {
      const file = await saveConversion("# ok", "https://exemplo.com/a", "article", dir);
      expect(path.dirname(file)).toBe(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });
  });

  it("corrige para 0700 uma pasta nossa que estava aberta", async () => {
    await withTmpdir(async (dir) => {
      mkdirSync(dir, { mode: 0o755 });
      await saveConversion("# ok", "https://exemplo.com/a", "article", dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });
  });

  it("recusa a pasta padrão quando é link simbólico e não grava no alvo", async () => {
    await withTmpdir(async (dir) => {
      const atacante = mkdtempSync(path.join(tmp, "atacante-"));
      symlinkSync(atacante, dir);
      await expect(saveConversion("# x", "https://exemplo.com/a", "article", dir)).rejects.toThrow(/link simbólico/);
      expect(readdirSync(atacante)).toEqual([]);
      expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    });
  });

  it("recusa a pasta padrão quando pertence a outro usuário", async () => {
    await withTmpdir(async (dir) => {
      mkdirSync(dir, { mode: 0o700 });
      const uid = process.getuid?.() ?? 0;
      const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        await expect(prepareOutputDir(dir, true)).rejects.toThrow(/outro usuário/);
      } finally {
        spy.mockRestore();
      }
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});

describe.runIf(posix)("pasta escolhida pelo usuário", () => {
  it("existente com permissões abertas: não altera e avisa uma vez no stderr", async () => {
    const dir = mkdtempSync(path.join(tmp, "aberta-"));
    mkdirSync(dir, { recursive: true });
    rmSync(dir, { recursive: true });
    mkdirSync(dir, { mode: 0o755 });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await saveConversion("# a", "https://exemplo.com/1", "article", dir);
      await saveConversion("# b", "https://exemplo.com/2", "article", dir);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]?.[0])).toContain("acessível a outros usuários");
    } finally {
      err.mockRestore();
    }
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });
});

describe("cleanupOldFiles", () => {
  const DAY = 24 * 3600 * 1000;
  const age = (file: string, days: number) => {
    const t = new Date(Date.now() - days * DAY);
    utimesSync(file, t, t);
  };

  it("remove só arquivos nossos antigos, preservando novos, estranhos, links e pastas", async () => {
    const dir = mkdtempSync(path.join(tmp, "limpeza-"));
    const hash = "0123456789abcdef";
    const oldMd = path.join(dir, `exemplo.com_a-${hash}.md`);
    const oldFull = path.join(dir, `exemplo.com_a-${hash}.full.md`);
    const newMd = path.join(dir, `exemplo.com_b-${hash}.md`);
    const staleTmp = path.join(dir, `exemplo.com_a-${hash}.md.tmp-0123456789ab`);
    const foreign = path.join(dir, "minhas-notas.md");
    const legacy8 = path.join(dir, "exemplo.com_a-01234567.md");
    const sub = path.join(dir, `subpasta-${hash}.md`);
    for (const f of [oldMd, oldFull, newMd, staleTmp, foreign, legacy8]) writeFileSync(f, "x");
    mkdirSync(sub);
    for (const f of [oldMd, oldFull, staleTmp, foreign, legacy8]) age(f, 30);
    age(sub, 30);
    if (posix) {
      const alvo = path.join(tmp, "alvo-link.txt");
      writeFileSync(alvo, "x");
      age(alvo, 30);
      symlinkSync(alvo, path.join(dir, `link-${hash}.md`));
    }

    const removed = await cleanupOldFiles(dir, 7);
    expect(removed).toBe(3);
    const left = readdirSync(dir).sort();
    expect(left).toContain(path.basename(newMd));
    expect(left).toContain("minhas-notas.md");
    expect(left).toContain("exemplo.com_a-01234567.md");
    expect(left).toContain(path.basename(sub));
    if (posix) expect(left).toContain(`link-${hash}.md`);
    expect(left).not.toContain(path.basename(oldMd));
    expect(left).not.toContain(path.basename(oldFull));
    expect(left).not.toContain(path.basename(staleTmp));
  });

  it("temporário com mais de 1 h é removido mesmo dentro da retenção", async () => {
    const dir = mkdtempSync(path.join(tmp, "limpeza-tmp-"));
    const f = path.join(dir, "a-0123456789abcdef.md.tmp-0123456789ab");
    writeFileSync(f, "x");
    age(f, 0.5); // 12 h
    expect(await cleanupOldFiles(dir, 7)).toBe(1);
  });

  it("0 desativa; pasta inexistente não lança", async () => {
    const dir = mkdtempSync(path.join(tmp, "limpeza-zero-"));
    const f = path.join(dir, "a-0123456789abcdef.md");
    writeFileSync(f, "x");
    age(f, 365);
    expect(await cleanupOldFiles(dir, 0)).toBe(0);
    expect(existsSync(f)).toBe(true);
    expect(await cleanupOldFiles(path.join(dir, "nao-existe"), 7)).toBe(0);
  });

  it("saveConversion limpa uma vez por processo na pasta com retenção explícita", async () => {
    const dir = mkdtempSync(path.join(tmp, "limpeza-save-"));
    const f = path.join(dir, "velho-0123456789abcdef.md");
    writeFileSync(f, "x");
    age(f, 30);
    process.env.WEB2MD_RETENTION_DAYS = "7";
    try {
      await saveConversion("# novo", "https://exemplo.com/n", "article", dir);
    } finally {
      delete process.env.WEB2MD_RETENTION_DAYS;
    }
    expect(existsSync(f)).toBe(false);
    // numa segunda gravação o arquivo "velho" recriado não é mais varrido (uma vez por processo)
    writeFileSync(f, "x");
    age(f, 30);
    await saveConversion("# novo2", "https://exemplo.com/n2", "article", dir);
    expect(existsSync(f)).toBe(true);
  });

  it("pasta escolhida pelo usuário sem WEB2MD_RETENTION_DAYS não é limpa", async () => {
    const dir = mkdtempSync(path.join(tmp, "limpeza-user-"));
    const f = path.join(dir, "velho-0123456789abcdef.md");
    writeFileSync(f, "x");
    age(f, 30);
    delete process.env.WEB2MD_RETENTION_DAYS;
    await saveConversion("# novo", "https://exemplo.com/n", "article", dir);
    expect(existsSync(f)).toBe(true);
  });
});
