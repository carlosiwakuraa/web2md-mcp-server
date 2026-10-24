import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = mkdtempSync(path.join(tmpdir(), "web2md-batch-out-"));
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "web2md-batch-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const BATCH = "web2md_fetch_markdown_batch";

interface JsonRpcResponse {
  id: number;
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

/** Cliente JSON-RPC mínimo sobre stdio (mesmo padrão de server.test.ts). */
class StdioClient {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private proc: ChildProcessWithoutNullStreams;
  stderr = "";

  constructor() {
    this.proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, WEB2MD_OUTPUT_DIR: OUTPUT_DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.pending.get(msg.id)?.(msg);
      }
    });
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout em ${method}\nstderr: ${this.stderr}`)), timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }) + "\n");
    });
  }

  callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    const exited = new Promise<void>((resolve) => this.proc.once("exit", () => resolve()));
    this.proc.stdin.end();
    const killer = setTimeout(() => this.proc.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(killer);
  }
}

let client: StdioClient;
let httpServer: Server;
let baseUrl: string;

const bodyOf = (n: number) => `CORPO-UNICO-${n} ` + `texto de exemplo da página ${n}. `.repeat(10);

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    const m = /^\/page(\d+)\.md$/.exec(req.url ?? "");
    if (m) {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(`# Página ${m[1]}\n\n${bodyOf(Number(m[1]))}\n`);
    } else if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>x</title></head><body></body></html>");
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  client = new StdioClient();
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

describe("tool de lote via stdio", () => {
  it("tools/list mostra as duas tools, com a regra de subagentes na descrição do lote", async () => {
    const r = await client.request("tools/list");
    const tools = r.result!.tools as Array<Record<string, any>>;
    expect(tools.map((t) => t.name).sort()).toEqual(["web2md_fetch_markdown", BATCH]);
    const batch = tools.find((t) => t.name === BATCH)!;
    expect(batch.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(batch.description).toContain("subagents");
    expect(batch.description).toContain("NÃO leia");
    expect(batch.inputSchema.required).toEqual(["urls"]);
    expect(batch.inputSchema.properties.urls.maxItems).toBe(20);
    expect(Object.keys(batch.outputSchema.properties).sort()).toEqual(
      ["dispatch", "failed", "groups", "items", "objective", "output_dir", "succeeded", "total"].sort(),
    );
  });

  it("server/discover traz a versão do package.json e instructions", async () => {
    const r = await client.request("server/discover");
    const info = r.result!._meta["io.modelcontextprotocol/serverInfo"];
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(info.version).toBe(pkg.version);
    expect(JSON.stringify(r.result)).toContain("subagents");
  });

  it("return_content=false: dispatch saved, arquivos existem e o corpo não vai ao contexto", async () => {
    const urls = [`${baseUrl}/page1.md`, `${baseUrl}/page2.md`];
    const r = await client.callTool(BATCH, { urls, return_content: false });
    expect(r.result!.isError).toBeFalsy();
    const sc = r.result!.structuredContent;
    expect(sc.dispatch).toBe("saved");
    expect(sc.succeeded).toBe(2);
    expect(sc.failed).toBe(0);
    expect(sc.groups).toEqual([]);
    expect(sc.output_dir).toBe(OUTPUT_DIR);
    for (const item of sc.items) {
      expect(item.status).toBe("ok");
      expect(path.dirname(item.saved_path)).toBe(OUTPUT_DIR);
      expect(existsSync(item.saved_path)).toBe(true);
    }
    expect(readFileSync(sc.items[0].saved_path, "utf8")).toContain("CORPO-UNICO-1");
    const text: string = r.result!.content[0].text;
    expect(text).not.toContain("CORPO-UNICO");
    expect(JSON.stringify(sc)).not.toContain("CORPO-UNICO");
  });

  it("até inline_max_files: dispatch inline com o conteúdo no texto", async () => {
    const urls = [`${baseUrl}/page1.md`, `${baseUrl}/page2.md`];
    const r = await client.callTool(BATCH, { urls });
    expect(r.result!.structuredContent.dispatch).toBe("inline");
    const text: string = r.result!.content[0].text;
    expect(text).toContain("CORPO-UNICO-1");
    expect(text).toContain("CORPO-UNICO-2");
  });

  it("4 URLs com inline_max_files=3: dispatch subagents, plano correto e corpo fora do contexto", async () => {
    const urls = [1, 2, 3, 4].map((n) => `${baseUrl}/page${n}.md`);
    const r = await client.callTool(BATCH, {
      urls,
      inline_max_files: 3,
      files_per_agent: 3,
      objective: "comparar as páginas",
    });
    expect(r.result!.isError).toBeFalsy();
    const sc = r.result!.structuredContent;
    expect(sc.dispatch).toBe("subagents");
    expect(sc.objective).toBe("comparar as páginas");
    expect(sc.succeeded).toBe(4);
    expect(sc.groups).toHaveLength(2);
    expect(sc.groups[0].files).toHaveLength(3);
    expect(sc.groups[1].files).toHaveLength(1);
    const planned = sc.groups.flatMap((g: any) => g.files.map((f: any) => f.url));
    expect(planned).toEqual(urls);
    for (const g of sc.groups) {
      expect(g.agent_name).toBeTruthy();
      for (const f of g.files) expect(existsSync(f.saved_path)).toBe(true);
    }
    const text: string = r.result!.content[0].text;
    expect(text).not.toContain("CORPO-UNICO");
    expect(JSON.stringify(sc)).not.toContain("CORPO-UNICO");
    expect(text).toContain("comparar as páginas");
  });

  it("falha isolada: uma URL 404 no meio não derruba as demais", async () => {
    const urls = [`${baseUrl}/page1.md`, `${baseUrl}/missing`, `${baseUrl}/page3.md`];
    const r = await client.callTool(BATCH, { urls, return_content: false });
    expect(r.result!.isError).toBeFalsy();
    const sc = r.result!.structuredContent;
    expect(sc.succeeded).toBe(2);
    expect(sc.failed).toBe(1);
    expect(sc.items.map((i: any) => i.status)).toEqual(["ok", "error", "ok"]);
    expect(sc.items[1].error).toContain("404");
    expect(sc.items[1].saved_path).toBeNull();
  });

  it("isError só quando todas as URLs falham", async () => {
    const r = await client.callTool(BATCH, { urls: [`${baseUrl}/missing`] });
    expect(r.result!.isError).toBe(true);
  });

  it("URLs repetidas são convertidas uma vez; mais de 20 URLs é erro de validação", async () => {
    const dup = await client.callTool(BATCH, { urls: [`${baseUrl}/page1.md`, `${baseUrl}/page1.md`], return_content: false });
    expect(dup.result!.structuredContent.items).toHaveLength(1);
    const many = await client.callTool(BATCH, {
      urls: Array.from({ length: 21 }, (_, i) => `${baseUrl}/page${i}.md`),
    });
    expect(many.result!.isError).toBe(true);
  });

  it("URLs que só diferem pelo fragmento resultam em um único arquivo", async () => {
    const r = await client.callTool(BATCH, {
      urls: [`${baseUrl}/page1.md#a`, `${baseUrl}/page1.md#b`],
      return_content: false,
    });
    expect(r.result!.isError).toBeFalsy();
    const sc = r.result!.structuredContent;
    expect(sc.total).toBe(1);
    expect(sc.items).toHaveLength(1);
    expect(sc.items[0].status).toBe("ok");
    expect(existsSync(sc.items[0].saved_path)).toBe(true);
  });

  it("a tool antiga continua funcionando", async () => {
    const r = await client.callTool("web2md_fetch_markdown", { url: `${baseUrl}/page1.md` });
    expect(r.result!.isError).toBeFalsy();
    expect(r.result!.content[0].text).toContain("CORPO-UNICO-1");
    expect(r.result!.structuredContent.source).toBe("native-markdown");
  });
});
