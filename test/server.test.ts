import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = mkdtempSync(path.join(tmpdir(), "web2md-out-"));
const PROTOCOL_VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "web2md-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
}

/** Cliente JSON-RPC mínimo sobre stdio (MCP 2026-07-28: sem initialize, `_meta` em cada request). */
class StdioClient {
  readonly stdoutLines: string[] = [];
  stderr = "";
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private proc: ChildProcessWithoutNullStreams;

  constructor() {
    // node --import tsx: sem o wrapper do npx, o kill alcança o processo do servidor.
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
        this.stdoutLines.push(line);
        const msg = JSON.parse(line) as JsonRpcResponse; // lança se algo que não é JSON for parar no stdout
        this.pending.get(msg.id)?.(msg);
      }
    });
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout em ${method}\nstderr: ${this.stderr}`)), timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      const msg = { jsonrpc: "2.0", id, method, params: { ...params, _meta: META } };
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  callTool(args: Record<string, unknown>, timeoutMs?: number): Promise<JsonRpcResponse> {
    return this.request("tools/call", { name: "web2md_fetch_markdown", arguments: args }, timeoutMs);
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

const GUIDE_MD =
  "# Guia\n\nIntro.\n\n## Instalação\n\n" +
  Array.from({ length: 12 }, (_, i) => `Passo ${i} da instalação com texto de enchimento.`).join("\n\n") +
  "\n\n```bash\n# não sou heading\nnpm i\n```\n\n### Requisitos\n\nNode 20.\n\n## Uso\n\nUse assim.\n\n## Uso avançado\n\nOutra coisa.\n";

const NATIVE_MD =
  "# Documento nativo\n\n" +
  Array.from({ length: 30 }, (_, i) => `Parágrafo ${i}: texto de exemplo para paginação.`).join("\n\n") +
  "\n";

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    if (req.url === "/guide.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(GUIDE_MD);
    } else if (req.url === "/doc.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(NATIVE_MD);
    } else if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    } else if (req.url === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

describe("servidor MCP (stdio, spec 2026-07-28)", () => {
  it("responde a server/discover com a versão do protocolo e capability de tools", async () => {
    const r = await client.request("server/discover");
    expect(r.error).toBeUndefined();
    expect(r.result!.supportedVersions).toContain(PROTOCOL_VERSION);
    expect(r.result!.capabilities.tools).toBeDefined();
    expect(r.result!._meta["io.modelcontextprotocol/serverInfo"].name).toBe("web2md-mcp-server");
  });

  it("tools/list expõe a tool com schema e annotations corretos", async () => {
    const r = await client.request("tools/list");
    expect(r.result!.resultType).toBe("complete");
    const tools = r.result!.tools as Array<Record<string, any>>;
    expect(tools.map((t) => t.name).sort()).toEqual(["web2md_fetch_markdown", "web2md_fetch_markdown_batch"]);
    const tool = tools.find((t) => t.name === "web2md_fetch_markdown")!;

    expect(tool.name).toBe("web2md_fetch_markdown");
    expect(tool.title).toBeTruthy();
    expect(tool.description).toContain("start_index");
    expect(tool.description).toContain("mode");

    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    const input = tool.inputSchema;
    expect(input.type).toBe("object");
    expect(input.required).toEqual(["url"]);
    expect(input.additionalProperties).toBe(false);
    expect(Object.keys(input.properties).sort()).toEqual(
      ["include_links", "max_chars", "mode", "return_content", "section", "start_index", "url"].sort(),
    );
    expect(input.properties.mode.enum).toEqual(["article", "full", "outline"]);
    expect(input.properties.section.type).toBe("string");
    expect(input.required).toEqual(["url"]);
    expect(tool.description).toContain("outline");
    expect(tool.description).toContain("section");
    expect(input.properties.mode.default).toBe("article");
    expect(input.properties.max_chars.default).toBe(50000);
    expect(input.properties.start_index.default).toBe(0);
    expect(input.properties.start_index.minimum).toBe(0);
    expect(input.properties.include_links.default).toBe(false);
    expect(input.properties.return_content.default).toBe(true);
    for (const p of Object.values(input.properties) as Array<{ description?: string }>) {
      expect(p.description).toBeTruthy();
    }

    expect(tool.outputSchema.type).toBe("object");
    expect(Object.keys(tool.outputSchema.properties).sort()).toEqual(
      ["document_chars", "headings", "next_start_index", "saved_path", "section", "source", "total_chars", "url"].sort(),
    );
  });

  it("URL inválida devolve isError com mensagem (sem erro de protocolo)", async () => {
    for (const url of ["isto não é uma url", "ftp://exemplo.com/arquivo", ""]) {
      const r = await client.callTool({ url });
      expect(r.error).toBeUndefined();
      expect(r.result!.isError).toBe(true);
      expect(r.result!.resultType).toBe("complete");
      expect(r.result!.content[0].type).toBe("text");
      expect(r.result!.content[0].text).toMatch(/url/i);
    }
  });

  it("argumento desconhecido ou fora de faixa devolve isError", async () => {
    const extra = await client.callTool({ url: `${baseUrl}/doc.md`, foo: 1 });
    expect(extra.result!.isError).toBe(true);
    const range = await client.callTool({ url: `${baseUrl}/doc.md`, max_chars: 5 });
    expect(range.result!.isError).toBe(true);
    expect(range.result!.content[0].text).toContain("max_chars");
    const neg = await client.callTool({ url: `${baseUrl}/doc.md`, start_index: -1 });
    expect(neg.result!.isError).toBe(true);
  });

  it("Erro HTTP 404 vira isError com a mensagem da spec", async () => {
    const r = await client.callTool({ url: `${baseUrl}/missing` });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.content[0].text).toBe(`Erro HTTP 404 ao acessar ${baseUrl}/missing`);
  });

  it("content-type não suportado vira isError descritivo", async () => {
    const r = await client.callTool({ url: `${baseUrl}/img.png` });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.content[0].text).toContain("image/png");
  });

  it("falha de rede vira isError (sem stack trace)", async () => {
    const r = await client.callTool({ url: "http://nao-existe.invalid/" }, 40_000);
    expect(r.result!.isError).toBe(true);
    expect(r.result!.content[0].text).not.toMatch(/\n\s+at /);
  }, 45_000);

  it("Markdown nativo: frontmatter, structuredContent e paginação por start_index", async () => {
    const url = `${baseUrl}/doc.md`;
    const first = await client.callTool({ url, max_chars: 600 });
    expect(first.result!.isError).toBeFalsy();
    expect(first.result!.resultType).toBe("complete");
    const text1: string = first.result!.content[0].text;
    expect(text1.startsWith(`---\nurl: ${url}\n`)).toBe(true);
    expect(text1).toContain("source: native-markdown");
    expect(text1).toContain("# Documento nativo");

    const sc1 = first.result!.structuredContent;
    expect(sc1.url).toBe(url);
    expect(sc1.source).toBe("native-markdown");
    expect(sc1.total_chars).toBeGreaterThan(600);
    expect(typeof sc1.next_start_index).toBe("number");
    expect(text1).toContain(`start_index=${sc1.next_start_index}]`);
    expect(text1).toContain("[Conteúdo truncado: exibidos caracteres 0–");

    const second = await client.callTool({ url, max_chars: 600, start_index: sc1.next_start_index });
    const text2: string = second.result!.content[0].text;
    expect(text2).not.toContain("fetched_at:");
    expect(text2.startsWith("---")).toBe(false);

    // Percorre até o fim e confere que o corpo não perde parágrafos.
    let all = text1.split("\n\n---\n[Conteúdo truncado")[0]!;
    let next: number | null = sc1.next_start_index;
    while (next !== null) {
      const r = await client.callTool({ url, max_chars: 600, start_index: next });
      const t: string = r.result!.content[0].text;
      all += "\n\n" + t.split("\n\n---\n[Conteúdo truncado")[0]!;
      next = r.result!.structuredContent.next_start_index;
    }
    for (let i = 0; i < 30; i++) expect(all).toContain(`Parágrafo ${i}:`);
    expect(all.match(/Parágrafo 7:/g)).toHaveLength(1);
  });

  it("salva o documento completo na pasta de saída, mesmo com resposta paginada", async () => {
    const url = `${baseUrl}/doc.md`;
    const r = await client.callTool({ url, max_chars: 300 });
    const sc = r.result!.structuredContent;
    expect(sc.next_start_index).not.toBeNull();
    expect(path.dirname(sc.saved_path)).toBe(OUTPUT_DIR);
    expect(path.basename(sc.saved_path)).toMatch(/^127\.0\.0\.1_doc\.md-[0-9a-f]{8}\.md$/);

    const saved = readFileSync(sc.saved_path, "utf8");
    expect(saved.length).toBe(sc.total_chars);
    expect(saved.startsWith(`---\nurl: ${url}\n`)).toBe(true);
    expect(saved).not.toContain("[Conteúdo truncado");
    for (let i = 0; i < 30; i++) expect(saved).toContain(`Parágrafo ${i}:`);
  });

  it("start_index além do fim devolve isError com o tamanho total", async () => {
    const r = await client.callTool({ url: `${baseUrl}/doc.md`, start_index: 10_000_000 });
    expect(r.result!.isError).toBe(true);
    expect(r.result!.content[0].text).toMatch(/caracteres no total/);
  });

  it("return_content: false — texto compacto com 'Conversão concluída.', sem frontmatter, saved_path preenchido e next_start_index nulo", async () => {
    const url = `${baseUrl}/doc.md`;
    const r = await client.callTool({ url, return_content: false });
    expect(r.result!.isError).toBeFalsy();

    const text: string = r.result!.content[0].text;
    expect(text).toContain("Conversão concluída.");
    // Não deve conter o Markdown completo (sem frontmatter YAML)
    expect(text.startsWith("---\n")).toBe(false);
    expect(text).not.toContain("fetched_at:");

    const sc = r.result!.structuredContent;
    expect(typeof sc.saved_path).toBe("string");
    expect(sc.next_start_index).toBeNull();
  });

  it("return_content: true (padrão) continua entregando Markdown completo com frontmatter", async () => {
    const url = `${baseUrl}/doc.md`;
    const r = await client.callTool({ url, return_content: true });
    expect(r.result!.isError).toBeFalsy();

    const text: string = r.result!.content[0].text;
    expect(text.startsWith(`---\nurl: ${url}\n`)).toBe(true);
    expect(text).toContain("source: native-markdown");
  });

  it("mode=outline: índice com offsets, headings estruturados e arquivo salvo completo (mesmo arquivo de article)", async () => {
    const url = `${baseUrl}/guide.md`;
    const r = await client.callTool({ url, mode: "outline" });
    expect(r.result!.isError).toBeFalsy();
    const text: string = r.result!.content[0].text;
    expect(text.startsWith(`---\nurl: ${url}\n`)).toBe(true);
    expect(text).toContain("mode: outline");
    expect(text).toContain("slug: `instalacao`");
    expect(text).not.toContain("Passo 3 da instalação");

    const sc = r.result!.structuredContent;
    expect(sc.next_start_index).toBeNull();
    expect(sc.section).toBeNull();
    expect(sc.headings.map((h: any) => h.slug)).toEqual(["guia", "instalacao", "requisitos", "uso", "uso-avancado"]);
    expect(sc.headings[0]).toMatchObject({ heading: "Guia", level: 1, id: null });

    const saved = readFileSync(sc.saved_path, "utf8");
    expect(saved.length).toBe(sc.total_chars);
    expect(saved.length).toBe(sc.document_chars);
    expect(saved).toContain("Passo 3 da instalação");
    expect(saved).not.toContain("mode: outline");
    const inst = sc.headings.find((h: any) => h.slug === "instalacao");
    expect(saved.slice(inst.start, inst.end).startsWith("## Instalação")).toBe(true);
    expect(saved.slice(inst.start, inst.end)).toContain("### Requisitos");
    expect(path.basename(sc.saved_path)).toMatch(/^127\.0\.0\.1_guide\.md-[0-9a-f]{8}\.md$/);
  });

  it("section por slug, por texto e por fragmento da URL; a seção inclui subseções e bloco de código inteiro", async () => {
    const url = `${baseUrl}/guide.md`;
    const bySlug = await client.callTool({ url, section: "instalacao" });
    const text: string = bySlug.result!.content[0].text;
    expect(text).toContain("section: Instalação\nsection_slug: instalacao\n---");
    expect(text).toContain("# não sou heading\nnpm i\n```");
    expect(text).toContain("### Requisitos");
    expect(text).not.toContain("## Uso");
    const sc = bySlug.result!.structuredContent;
    expect(sc.section).toMatchObject({ heading: "Instalação", level: 2, slug: "instalacao" });
    expect(sc.total_chars).toBe(text.length);
    expect(sc.document_chars).toBeGreaterThan(sc.total_chars);
    expect(sc.headings).toBeNull();

    const byText = await client.callTool({ url, section: "USO AVANCADO" });
    expect(byText.result!.structuredContent.section.slug).toBe("uso-avancado");

    const byFragment = await client.callTool({ url: `${url}#requisitos` });
    expect(byFragment.result!.structuredContent.section.slug).toBe("requisitos");
    expect(byFragment.result!.content[0].text).toContain("Node 20.");

    const missFragment = await client.callTool({ url: `${url}#nao-existe` });
    expect(missFragment.result!.isError).toBeFalsy();
    expect(missFragment.result!.structuredContent.section).toBeNull();
    expect(missFragment.result!.content[0].text).toContain("Intro.");
  });

  it("section com paginação (max_chars/start_index) e com return_content=false", async () => {
    const url = `${baseUrl}/guide.md`;
    const first = await client.callTool({ url, section: "instalacao", max_chars: 300 });
    const sc = first.result!.structuredContent;
    expect(sc.next_start_index).not.toBeNull();
    expect(first.result!.content[0].text).toContain(`start_index=${sc.next_start_index}]`);
    expect(first.result!.content[0].text).toContain("section: Instalação");

    const second = await client.callTool({ url, section: "instalacao", max_chars: 300, start_index: sc.next_start_index });
    expect(second.result!.isError).toBeFalsy();
    expect(second.result!.content[0].text.startsWith("---")).toBe(false);

    const meta = await client.callTool({ url, section: "instalacao", return_content: false });
    const msc = meta.result!.structuredContent;
    expect(meta.result!.content[0].text).toContain("section: instalacao");
    expect(msc.total_chars).toBe(msc.document_chars);
    expect(readFileSync(msc.saved_path, "utf8").length).toBe(msc.document_chars);
  });

  it("section ambígua ou inexistente devolve isError em português listando headings", async () => {
    const url = `${baseUrl}/guide.md`;
    const amb = await client.callTool({ url, section: "us" });
    expect(amb.result!.isError).toBe(true);
    expect(amb.result!.content[0].text).toContain("ambígua");
    expect(amb.result!.content[0].text).toContain("uso-avancado");

    const none = await client.callTool({ url, section: "capítulo inexistente" });
    expect(none.result!.isError).toBe(true);
    expect(none.result!.content[0].text).toContain("não encontrada");
    expect(none.result!.content[0].text).toContain("instalacao");
  });

  it("nada além do protocolo vai para stdout; logs ficam em stderr", () => {
    expect(client.stdoutLines.length).toBeGreaterThan(5);
    for (const line of client.stdoutLines) {
      const msg = JSON.parse(line);
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id).toBeDefined();
    }
    expect(client.stderr).toContain("[web2md]");
  });
});
