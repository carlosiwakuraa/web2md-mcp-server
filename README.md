# web2md-mcp-server

Servidor MCP que recebe uma URL, faz a requisição a partir da sua máquina e devolve a página como Markdown GFM fiel à estrutura original, com frontmatter YAML.

A tool exposta se chama `web2md_fetch_markdown`. Ela não altera o servidor remoto, mas grava cada conversão em disco (ver [Pasta de saída](#pasta-de-saída)); por isso `readOnlyHint` é `false` (`destructiveHint: false`, `idempotentHint` e `openWorldHint` ficam `true`).

Desde a v1.2.0 há também a tool `web2md_fetch_markdown_batch`, que converte várias URLs de uma vez (ver [Conversão em lote](#conversão-em-lote-v120)).

## Novidades da v1.2.0

- Nova tool `web2md_fetch_markdown_batch`: converte de 1 a 20 URLs em Markdown em uma só chamada.
- O destino do conteúdo depende da **quantidade de arquivos**: só manifesto, conteúdo inline ou plano de subagentes (ver a [tabela](#o-que-acontece-conforme-a-quantidade-de-arquivos)).
- Conversão com concorrência 4, deduplicação de URLs repetidas e falha isolada por URL.
- A tool `web2md_fetch_markdown` (uma URL) continua igual.

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

## Conversão em lote (v1.2.0)

A tool `web2md_fetch_markdown_batch` recebe várias URLs, converte cada uma para Markdown (mesmo pipeline da tool de URL única) e grava um arquivo `.md` completo por página na [pasta de saída](#pasta-de-saída). O que volta ao contexto do modelo depende de `return_content` e da quantidade de arquivos convertidos.

A conversão é **determinística**: é feita pelo servidor, sem chamar modelo, e **não gasta tokens**. Só gasta tokens o conteúdo que você decide trazer ao contexto, e é para controlar isso que existe a lógica por quantidade de arquivos.

### Parâmetros do lote

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `urls` | array de strings (1–20) | obrigatório | URLs `http://` ou `https://`. URLs repetidas são convertidas uma única vez. |
| `mode` | `"article"` \| `"full"` | `"article"` | Modo de extração aplicado a todas as URLs (mesmo significado da tool de URL única). |
| `include_links` | booleano | `false` | Anexa a seção `## Links da página` em cada documento. |
| `return_content` | booleano | `true` | `false` salva tudo em disco e devolve só o manifesto, sem conteúdo no contexto. `true` traz o conteúdo conforme a tabela abaixo. |
| `inline_max_files` | inteiro (1–20) | `3` | Com `return_content=true`, quantidade máxima de arquivos convertidos que ainda vêm inline. Acima disso, a resposta é um plano de subagentes. |
| `files_per_agent` | inteiro (1–20) | `5` | No plano de subagentes, quantos arquivos cada subagente recebe. `1` = um subagente por arquivo. |
| `objective` | string (até 2000 caracteres) | não definido | O que você quer das páginas (ex.: "comparar as opções de autenticação"). É repassado aos subagentes para guiar a extração. |
| `max_chars` | inteiro (100–500000) | `50000` | Só no modo inline: máximo de caracteres de cada documento no contexto. O arquivo salvo é sempre completo. |

### O que acontece conforme a quantidade de arquivos

A contagem considera os arquivos convertidos com sucesso. Se nenhuma URL for convertida, o `dispatch` é `saved` (só o manifesto, com os erros).

| Situação | `dispatch` | O que vai ao contexto principal |
|---|---|---|
| `return_content=false` | `saved` | Só o manifesto. Os `.md` ficam em disco e **nada** do conteúdo entra no contexto. |
| `return_content=true` e até 3 arquivos (`inline_max_files`) | `inline` | O conteúdo de cada documento, inline na resposta (limitado por `max_chars`). |
| `return_content=true` e mais de 3 arquivos | `subagents` | **Não** vem conteúdo. A resposta traz um plano (`groups`) e o agente deve invocar **um subagente por grupo** de arquivos (5 por subagente por padrão; com `files_per_agent=1`, um por arquivo), repassando o `objective`. Cada subagente lê só os arquivos do seu grupo e devolve uma extração objetiva. |

### Quem dispara os subagentes

O servidor apenas **monta o plano**: ele agrupa os arquivos, sugere o nome de cada subagente (`agent_name`) e inclui as instruções no texto da resposta. Quem **dispara** os subagentes é o cliente MCP (o agente). Essa orientação está na descrição da tool, sem imposição técnica: um servidor MCP não consegue criar subagentes, e o cliente pode ignorar o plano. Em clientes sem suporte a subagentes, use `return_content=false` e leia os arquivos salvos conforme a necessidade.

### Exemplos de pedidos em linguagem natural

- **"Converta estas 8 URLs e salve em arquivo."** O agente chama a tool com `return_content=false`. Os 8 `.md` vão para a pasta de saída e só o manifesto volta ao contexto.
- **"Converta estas 8 URLs e compare X."** O agente chama a tool com `return_content=true` e `objective` descrevendo a comparação. Como são mais de 3 arquivos, a resposta traz o plano com 2 grupos (5 + 3 arquivos). O agente invoca 2 subagentes, cada um lê só os seus arquivos e devolve a extração do que importa para a comparação, e o agente principal compara os resultados sem carregar as 8 páginas inteiras.
- **"Converta estas 2 URLs e me diga o que mudou."** Com até 3 arquivos, o conteúdo vem inline e o agente trabalha direto.

### Retorno

O texto da resposta muda conforme o `dispatch` (manifesto, documentos inline ou plano de subagentes). O `structuredContent` sempre traz:

| Campo | Descrição |
|---|---|
| `dispatch` | `"saved"`, `"inline"` ou `"subagents"`. Com `subagents`, o conteúdo **não** está no contexto: siga o plano em `groups`. |
| `total` | Quantidade de URLs únicas processadas. |
| `succeeded` | Quantas foram convertidas. |
| `failed` | Quantas falharam. |
| `output_dir` | Pasta onde os arquivos foram salvos. |
| `objective` | O objetivo informado, ou `null`. |
| `items` | Um item por URL: `url`, `final_url` (após redirects), `slug`, `status` (`ok` ou `error`), `title`, `source`, `total_chars` (tamanho do documento completo salvo), `saved_path` e `error`. |
| `groups` | Plano de subagentes: lista de `{ agent_name, files: [{ slug, url, saved_path }] }`. Vazio quando `dispatch` não é `subagents`. |

### Detalhes de comportamento

- **Concorrência 4:** até 4 URLs são buscadas ao mesmo tempo; a ordem de `items` e `groups` segue a ordem original das URLs.
- **Deduplicação:** URLs repetidas na lista são convertidas uma única vez.
- **Falha isolada por URL:** um erro (404, timeout, página que depende de JavaScript etc.) marca só aquele item como `error`, com a mensagem em `error`; as demais URLs seguem normalmente e só as convertidas entram no plano.
- **Nomes de arquivo:** iguais aos da tool de URL única (`<host>_<caminho>-<hash>.md`, com `.full` em `mode="full"`). O `slug` de cada item é o nome do arquivo sem `.md` e serve de identificador, inclusive como nome do subagente.
- **Pasta de saída:** a mesma da tool de URL única; para trocar, defina `WEB2MD_OUTPUT_DIR`. O arquivo salvo contém sempre o documento completo, independentemente de `max_chars`.

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
