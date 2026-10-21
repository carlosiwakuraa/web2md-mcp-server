# Spec: `web2md` MCP Server

## 1. Objetivo

Expor ao Claude uma ferramenta que recebe uma URL, faz a requisição a partir da máquina onde o MCP roda e devolve o conteúdo da página como Markdown (GFM) fiel à estrutura semântica do original.

## 2. Interface da ferramenta

```
fetch_markdown(
  url: string,                 # obrigatório
  mode: "article" | "full",    # padrão "article"
  max_chars: int = 50000,      # limite por resposta
  start_index: int = 0,        # paginação de páginas longas
  include_links: bool = false  # anexa seção com todos os links da página
) -> string
```

O modo `article` extrai só o conteúdo principal (sem menu, rodapé ou barra lateral). O modo `full` converte o `<body>` inteiro, útil quando a extração erra o conteúdo. Quando o resultado passa de `max_chars`, a resposta termina com um marcador indicando o próximo `start_index`, para o Claude pedir a continuação.

## 3. Pipeline

O processamento segue seis etapas, nesta ordem.

1. **Atalho nativo.** Envia `Accept: text/markdown, text/html;q=0.9`. Se a resposta vier com `content-type` de Markdown, retorna direto. Há também regras por domínio, como anexar `.md` em `developer.apple.com`.
2. **Fetch.** Segue redirects, usa timeout de 30 s e detecta o encoding (header, depois `<meta charset>`, depois detecção automática). Para conteúdo que não é HTML, retorna erro descritivo (ou delega PDFs para outro conversor, numa versão futura).
3. **Limpeza.** Remove `script`, `style`, `noscript`, `svg`, `form`, `button`, `iframe` de anúncios e elementos com `hidden` ou `aria-hidden="true"`.
4. **Extração** (só no modo `article`). Usa `<main>`, depois `<article>`, depois `[role=main]`, depois um algoritmo tipo Readability. Remove `nav`, `header`, `footer` e `aside` que não sejam avisos de conteúdo.
5. **Conversão.** Aplica as regras da seção 5, nó a nó.
6. **Pós-processamento.** Resolve URLs relativas para absolutas (respeitando `<base href>`), colapsa mais de duas linhas em branco seguidas, remove espaços no fim das linhas e garante um único H1.

## 4. Template de saída

```markdown
---
url: https://exemplo.com/docs/pagina
canonical: https://exemplo.com/docs/pagina
title: Título da página
description: Conteúdo da meta description
lang: pt-BR
fetched_at: 2026-10-20T22:32:00-03:00
source: html            # ou "native-markdown"
---

# Título da página

Conteúdo convertido...

<!-- opcional, se include_links=true -->
## Links da página
- [Texto](https://...)
```

O frontmatter dá ao Claude o contexto de origem sem poluir o corpo. O H1 vem do primeiro `<h1>` do conteúdo; se ele não existir, usa o `<title>`.

## 5. Regras de conversão

| HTML | Markdown | Observações |
|---|---|---|
| `h1`–`h6` | `#` a `######` | Preserva o nível original. Se a página tiver vários `h1`, os seguintes viram `##`. |
| `p` | parágrafo separado por linha em branco | |
| `strong`, `b` | `**texto**` | |
| `em`, `i` | `*texto*` | |
| `del`, `s` | `~~texto~~` | |
| `code` (inline) | `` `texto` `` | Se o texto contém crase, usa delimitador duplo (` `` a`b `` `). |
| `pre > code` | bloco cercado com ```` ``` ```` | Linguagem tirada de `class="language-x"`, `lang-x` ou `data-lang`. Preserva espaços exatamente. |
| `a` | `[texto](url "title")` | URL absoluta. Âncora sem texto é descartada. Link cujo texto é igual à URL vira `<url>`. |
| `img` | `![alt](src "title")` | Usa `srcset` de maior resolução se `src` estiver vazio. Sem `alt`, usa `![](src)`. |
| `ul`, `ol` | `-` / `1.` | Aninhamento com 2 espaços (ul) ou 3 (ol). Respeita `start` em `ol`. |
| `li` com `input[type=checkbox]` | `- [ ]` / `- [x]` | Task list do GFM. |
| `blockquote` | `> ` | Aninhável. |
| avisos (`aside.note`, `.callout`, `.admonition`, `[role=note]`) | `> [!NOTE]` | Mapeia para NOTE, TIP, IMPORTANT, WARNING ou CAUTION conforme a classe ou o título do aviso. |
| `hr` | `---` | |
| `br` | `\` no fim da linha | Mais explícito que dois espaços. |
| `table` simples | tabela GFM | Primeira linha (ou `thead`) vira cabeçalho. Escapa `\|` dentro das células. |
| `table` com `colspan`/`rowspan` ou blocos dentro das células | HTML embutido | Fallback para não perder estrutura. |
| `dl` / `dt` / `dd` | `**termo**` seguido do texto da definição | GFM não tem lista de definição. |
| `details` / `summary` | HTML embutido | Renderiza em GFM e preserva o conteúdo recolhível. |
| `sup`, `sub`, `kbd`, `mark` | HTML embutido | Sem equivalente em Markdown. |
| `video`, `audio`, `iframe` de conteúdo | `[Vídeo: título](src)` | Vira link. |
| `math` / MathJax / KaTeX | `$...$` / `$$...$$` | Usa a anotação TeX original quando disponível. |
| elementos desconhecidos | só o texto dos filhos | Nunca descarta texto silenciosamente. |

Regras transversais:
- Escapar caracteres especiais de Markdown (`*`, `_`, `#`, `[`, `` ` ``, `|`) em texto comum, mas nunca dentro de blocos de código.
- Preservar `id` de títulos como `<a id="..."></a>` antes do título, para que links internos (`#secao`) continuem funcionando.
- Espaços em branco do HTML são colapsados, exceto dentro de `pre`.

## 6. Tratamento de erros

O servidor deve retornar mensagens claras que o Claude consiga interpretar:
- HTTP 4xx/5xx: `Erro HTTP 404 ao acessar <url>`.
- Timeout.
- Content-type não suportado.
- Página vazia após a extração, com a sugestão de tentar `mode="full"`.
- Página que provavelmente depende de JavaScript, quando o corpo tem pouco texto e muitos `<script>`.

## 7. Testes

Usar *golden files*: uma pasta `fixtures/` com pares `pagina.html` → `pagina.expected.md`, cobrindo cada linha da tabela da seção 5, mais páginas reais de alguns sites de documentação (Apple, MDN, docs de alguma lib que vocês usem). O teste compara a saída com o esperado. Isso também protege as regras quando você mexer nelas depois.

## 8. Fora do escopo da v1

Ficam para depois: renderização de JavaScript (v2, com Playwright como fetcher alternativo), páginas autenticadas, PDFs e cache.
