import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Roda um trecho ESM que instala os guards de src/index.ts e dispara `trigger`. */
function run(trigger: string) {
  const code = `
    const { installProcessGuards } = await import("./src/index.ts");
    installProcessGuards();
    setInterval(() => {}, 1000); // mantém o processo vivo: só os guards podem encerrá-lo
    ${trigger}
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("installProcessGuards", { timeout: 30_000 }, () => {
  it("uncaughtException: loga no stderr (sem credenciais) e encerra com código 1", () => {
    const r = run(`setTimeout(() => { throw new Error("falhou em https://user:senha@host.exemplo/x"); }, 10);`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("uncaughtException");
    expect(r.stderr).toContain("encerrando o servidor");
    expect(r.stderr).not.toContain("senha");
    expect(r.stdout).toBe(""); // stdout é do protocolo MCP
  });

  it("unhandledRejection: também encerra com código != 0", () => {
    const r = run(`setTimeout(() => { Promise.reject(new Error("rejeitada")); }, 10);`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unhandledRejection");
    expect(r.stderr).toContain("rejeitada");
  });
});
