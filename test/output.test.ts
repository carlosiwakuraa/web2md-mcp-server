import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outputFileName, resolveOutputDir, saveConversion } from "../src/output.js";

const tmp = mkdtempSync(path.join(tmpdir(), "web2md-output-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("outputFileName", () => {
  it("monta host + caminho + hash, só com caracteres seguros", () => {
    const name = outputFileName("https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table", "article");
    expect(name).toMatch(/^developer\.mozilla\.org_en-US_docs_Web_HTML_Element_table-[0-9a-f]{8}\.md$/);
  });

  it("é estável para a mesma URL e distingue query e modo", () => {
    const a = outputFileName("https://exemplo.com/p?id=1", "article");
    expect(outputFileName("https://exemplo.com/p?id=1", "article")).toBe(a);
    expect(outputFileName("https://exemplo.com/p?id=2", "article")).not.toBe(a);
    expect(outputFileName("https://exemplo.com/p?id=1", "full")).toMatch(/\.full\.md$/);
  });

  it("trata raiz, acentos e caminhos longos", () => {
    expect(outputFileName("https://exemplo.com/", "article")).toMatch(/^exemplo\.com-[0-9a-f]{8}\.md$/);
    expect(outputFileName("https://exemplo.com/açaí/página", "article")).toMatch(/^exemplo\.com_acai_pagina-/);
    expect(outputFileName(`https://exemplo.com/${"a".repeat(500)}`, "article").length).toBeLessThan(140);
  });
});

describe("resolveOutputDir", () => {
  it("usa WEB2MD_OUTPUT_DIR quando definida", () => {
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: tmp })).toBe(tmp);
  });

  it("vazio, só espaços ou placeholder não resolvido caem no padrão", () => {
    for (const v of ["", "   ", "${user_config.output_dir}", "  ${user_config.output_dir} "]) {
      expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: v })).toBe(path.join(tmpdir(), "web2md"));
    }
  });

  it("valor válido é usado após trim", () => {
    expect(resolveOutputDir({ WEB2MD_OUTPUT_DIR: `  ${tmp}  ` })).toBe(tmp);
  });

  it("padrão: os.tmpdir()/web2md", () => {
    expect(resolveOutputDir({})).toBe(path.join(tmpdir(), "web2md"));
  });
});

describe("saveConversion", () => {
  it("cria a pasta, grava o arquivo e sobrescreve numa reconversão", async () => {
    const dir = path.join(tmp, "nova", "pasta");
    const url = "https://exemplo.com/doc";
    const file = await saveConversion("# v1\n", url, "article", dir);
    expect(path.dirname(file)).toBe(dir);
    expect(readFileSync(file, "utf8")).toBe("# v1\n");

    const again = await saveConversion("# v2\n", url, "article", dir);
    expect(again).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("# v2\n");
  });
});
