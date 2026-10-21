/**
 * Golden files: fixtures/*.html e fixtures/real/*.html -> *.expected.md
 *
 * Opções por fixture em `<nome>.options.json`:
 *   { "mode": "article" | "full", "includeLinks": boolean, "url": string }
 * Padrões: mode "full", includeLinks false, url https://exemplo.com/fixtures/<nome>.html
 *
 * Variáveis de ambiente:
 *   UPDATE_GOLDEN=1    grava o .expected.md apenas das fixtures que ainda não têm um
 *   UPDATE_GOLDEN=all  regrava TODOS os .expected.md (sobrescreve; revise o diff!)
 *
 * Fixtures sem .expected.md (e sem UPDATE_GOLDEN) são puladas com aviso.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertHtml } from "../src/pipeline.js";
import type { Mode } from "../src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(ROOT, "fixtures");
const REAL_DIR = join(FIXTURES_DIR, "real");
const UPDATE = process.env.UPDATE_GOLDEN ?? "";

interface FixtureOptions {
  mode?: Mode;
  includeLinks?: boolean;
  url?: string;
}

interface Fixture {
  /** Nome exibido, ex.: "table-simple" ou "real/mdn-details". */
  name: string;
  htmlPath: string;
  expectedPath: string;
  optionsPath: string;
  group: "synthetic" | "real";
}

function discover(dir: string, group: Fixture["group"], prefix: string): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .sort()
    .map((file) => {
      const base = basename(file, ".html");
      return {
        name: `${prefix}${base}`,
        htmlPath: join(dir, file),
        expectedPath: join(dir, `${base}.expected.md`),
        optionsPath: join(dir, `${base}.options.json`),
        group,
      };
    });
}

function readOptions(fx: Fixture): Required<FixtureOptions> {
  const raw: FixtureOptions = existsSync(fx.optionsPath)
    ? (JSON.parse(readFileSync(fx.optionsPath, "utf8")) as FixtureOptions)
    : {};
  const base = basename(fx.htmlPath);
  return {
    mode: raw.mode ?? "full",
    includeLinks: raw.includeLinks ?? false,
    url: raw.url ?? `https://exemplo.com/fixtures/${base}`,
  };
}

function runFixture(fx: Fixture): string {
  const opts = readOptions(fx);
  const html = readFileSync(fx.htmlPath, "utf8");
  return convertHtml(html, opts.url, { mode: opts.mode, includeLinks: opts.includeLinks }).body;
}

const synthetic = discover(FIXTURES_DIR, "synthetic", "");
const real = discover(REAL_DIR, "real", "real/");

function defineGoldenTests(title: string, fixtures: Fixture[]): void {
  describe(title, () => {
    it("há fixtures para testar", () => {
      expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const fx of fixtures) {
      const hasExpected = existsSync(fx.expectedPath);
      const shouldWrite = UPDATE === "all" || (UPDATE === "1" && !hasExpected);

      if (shouldWrite) {
        it(`${fx.name} (UPDATE_GOLDEN: gravando expected)`, () => {
          const body = runFixture(fx);
          writeFileSync(fx.expectedPath, body, "utf8");
        });
      } else if (!hasExpected) {
        it.skip(`${fx.name} (sem .expected.md; rode com UPDATE_GOLDEN=1 para gerar)`, () => {});
      } else {
        it(fx.name, () => {
          const expected = readFileSync(fx.expectedPath, "utf8");
          const actual = runFixture(fx);
          expect(actual, `fixture "${fx.name}" divergiu de ${basename(fx.expectedPath)}`).toBe(expected);
        });
      }
    }
  });
}

defineGoldenTests("golden: fixtures sintéticas", synthetic);
defineGoldenTests("golden: páginas reais", real);

// Auto-verificação do formato dos .expected.md escritos à mão (não depende do código em src/).
describe("golden: formato dos expected.md", () => {
  const withExpected = [...synthetic, ...real].filter((fx) => existsSync(fx.expectedPath));

  it("toda fixture sintética tem .expected.md", () => {
    const missing = synthetic.filter((fx) => !existsSync(fx.expectedPath)).map((fx) => fx.name);
    expect(missing, "fixtures sem expected").toEqual([]);
  });

  for (const fx of withExpected) {
    it(`${fx.name}: expected bem formado`, () => {
      const md = readFileSync(fx.expectedPath, "utf8");
      expect(/^(<a id="[^"]*"><\/a>\n)?# /.test(md), "começa com H1 (opcionalmente precedido de âncora de id)").toBe(true);
      expect(md.endsWith("\n") && !md.endsWith("\n\n"), "termina com um único \\n").toBe(true);
      expect(/[ \t]+$/m.test(md), "sem espaço no fim de linha").toBe(false);
      expect(/\n{4,}/.test(md), "no máx. 2 linhas em branco seguidas").toBe(false);
      expect(md.includes("\r"), "sem CR").toBe(false);
      expect(md.startsWith("---\n"), "sem frontmatter").toBe(false);
    });
  }
});
