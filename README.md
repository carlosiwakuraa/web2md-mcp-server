# web2md-mcp-server

Servidor MCP que recebe uma URL, faz a requisição a partir da sua máquina e devolve a página como Markdown GFM fiel à estrutura original, com frontmatter YAML.

A tool exposta se chama `web2md_fetch_markdown`. Ela não altera o servidor remoto, mas grava cada conversão em disco (ver [Pasta de saída](#pasta-de-saída)); por isso `readOnlyHint` é `false` (`destructiveHint: false`, `idempotentHint` e `openWorldHint` ficam `true`).

## Instalação

```bash
npm install && npm run build
```

Requer Node 20 ou superior. O build gera `dist/index.js`.

### Claude Code

```bash
claude mcp add web2md -- node /caminho/para/web2md/dist/index.js
```

### Claude Desktop

Em `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "web2md": {
      "command": "node",
      "args": ["/caminho/para/web2md/dist/index.js"]
    }
  }
}
```

Em desenvolvimento, use `npm run dev` (roda `src/index.ts` com `tsx`).

## Configuração de rede

### Certificados CA corporativos (proxies TLS, redes internas)

Em ambientes com certificados CA próprios (bancos, empresas, VPNs), as requisições podem falhar com erro de certificado. Passe `NODE_OPTIONS=--use-system-ca` via `env` no seu cliente MCP para que o Node.js confie no store de certificados do sistema operacional:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "web2md": {
      "command": "node",
      "args": ["/caminho/para/web2md/dist/index.js"],
      "env": {
        "NODE_OPTIONS": "--use-system-ca"
      }
    }
  }
}
```

**VS Code / Copilot** (`.vscode/mcp.json` ou `settings.json`):

```json
{
  "servers": {
    "web2md": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/para/web2md/dist/index.js"],
      "env": {
        "NODE_OPTIONS": "--use-system-ca"
      }
    }
  }
}
```

> `--use-system-ca` requer Node.js 22 ou superior. Em versões anteriores, use `NODE_EXTRA_CA_CERTS=/caminho/para/ca-bundle.pem` apontando para o arquivo `.pem` com os certificados da sua organização.

## Parâmetros

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `url` | string | obrigatório | URL `http://` ou `https://` da página. |
| `mode` | `"article"` \| `"full"` | `"article"` | `article` extrai só o conteúdo principal (sem menu, rodapé e barra lateral). `full` converte o `<body>` inteiro; use quando a extração errar o conteúdo. |
| `max_chars` | inteiro (100–500000) | `50000` | Limite de caracteres por resposta. |
| `start_index` | inteiro ≥ 0 | `0` | Posição do documento onde a resposta começa, para paginar. |
| `include_links` | booleano | `false` | Anexa a seção `## Links da página` com os links do conteúdo. |

Além do texto, a resposta traz `structuredContent` com `{ url, source, total_chars, next_start_index, saved_path }`.

### Pasta de saída

Toda conversão bem-sucedida é salva em `output/` (na raiz do projeto, ao lado de `dist/`). O arquivo sempre contém o **documento completo** (frontmatter + corpo), independentemente de `max_chars` e `start_index`, e `saved_path` no `structuredContent` traz o caminho absoluto.

- Nome do arquivo: `<host>_<caminho>-<hash>.md`, com `.full` antes da extensão em `mode="full"`. O hash de 8 caracteres cobre a URL inteira (com query), então URLs diferentes não colidem.
- Reconverter a mesma URL e modo sobrescreve o arquivo (inclusive nas chamadas de paginação).
- Para usar outra pasta, defina `WEB2MD_OUTPUT_DIR` (caminho absoluto recomendado). No Claude Desktop: `"env": { "WEB2MD_OUTPUT_DIR": "/caminho/para/output" }`.
- Se a gravação falhar (permissão, disco cheio), a conversão continua e volta normalmente, com `saved_path: null` e o motivo no `stderr`.

### Paginação

Quando o documento passa de `max_chars`, a resposta termina com um marcador:

```
---
[Conteúdo truncado: exibidos caracteres 0–49812 de 120344. Para continuar, chame novamente com start_index=49812]
```

Chame a tool de novo com o mesmo `url` e `start_index=49812`. O frontmatter aparece só na primeira parte. Um `start_index` além do fim do documento devolve erro.

## Exemplo de saída

```markdown
---
url: https://exemplo.com/docs/pagina
canonical: https://exemplo.com/docs/pagina
title: Título da página
description: Conteúdo da meta description
lang: pt-BR
fetched_at: 2026-10-20T22:32:00-03:00
source: html
---

# Título da página

Conteúdo convertido...
```

`source` é `native-markdown` quando o servidor remoto responde com Markdown (a tool envia `Accept: text/markdown, text/html;q=0.9`).

## Erros

Os erros voltam como resultado com `isError: true` e uma mensagem que o Claude consegue interpretar:

- URL inválida (só `http`/`https`).
- `Erro HTTP 404 ao acessar <url>` (qualquer 4xx/5xx).
- Timeout (30 s) e falhas de rede.
- Content-type não suportado (só HTML e Markdown; PDFs e imagens não são convertidos).
- Página vazia após a extração, com a sugestão de usar `mode="full"`.
- Página que provavelmente depende de JavaScript (pouco texto e muitos `<script>`).
- `start_index` fora do documento.

Os logs vão para `stderr`; o `stdout` carrega só o protocolo.

## Testes

```bash
npm test
```

Roda o vitest: golden files em `fixtures/` (`pagina.html` → `pagina.expected.md`), testes unitários dos estágios e um teste do servidor que sobe `src/index.ts` por stdio e fala JSON-RPC (`server/discover`, `tools/list`, `tools/call`).

## Limitações conhecidas

- Em `mode="article"`, páginas sem `<main>`, `<article>` ou `[role=main]` caem no Readability, que pode descartar seções inteiras de documentos longos (ex.: a especificação XML 1.0 da W3C perde cerca de 17% do texto). Se faltar conteúdo, use `mode="full"`.
- Sem execução de JavaScript: SPAs devolvem o erro "depende de JavaScript" ou pouco conteúdo.
- Em blocos de código com abas (VitePress/Docusaurus), os rótulos das abas aparecem como texto solto.

## Fora do escopo da v1

Renderização de JavaScript (previsto para a v2, com Playwright), páginas autenticadas, PDFs e cache.
