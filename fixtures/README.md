# Fixtures (golden files)

Pares `nome.html` -> `nome.expected.md` (+ `nome.options.json` opcional:
`{"mode","includeLinks","url"}`; padrão: `full`, `false`, `https://exemplo.com/fixtures/<nome>.html`).
O expected é exatamente `convertHtml(...).body` (sem frontmatter/paginação), escrito à mão a partir da SPEC.

Rodar: `npx vitest run test/golden.test.ts`.
Gerar expected que faltam (ex. `fixtures/real/*`): `UPDATE_GOLDEN=1 npx vitest run test/golden.test.ts`.
Regravar tudo (sobrescreve; revisar o diff): `UPDATE_GOLDEN=all ...`.
`fixtures/real/*.html` ficam sem expected até o orquestrador gerar e revisar (são puladas).
`fixtures/real/apple-array.native.md` é só referência (Markdown nativo servido pela Apple).

## Decisões em pontos ambíguos da SPEC (revisar)

1. **Ids de títulos**: `<a id="x"></a>` numa linha própria, imediatamente antes do título (sem linha em branco). Id em `h1` não é testado (exceto h1 rebaixado em `multiple-h1`).
2. **Vários h1**: só os h1 seguintes viram `##`; h2..h6 mantêm o nível. H1 sempre no lugar (ordem do documento); as fixtures evitam texto antes do primeiro h1 (exceto `full-vs-article-full`, onde o h1 é o primeiro nó).
3. **ol**: numeração sequencial (`1.`, `2.`...) a partir de `start`. Indentação aninhada pelo marcador pai (ul: 2, ol: 3), inclusive ul dentro de ol e vice-versa.
4. **Avisos**: tipo por classe, senão pelo título (`Warning`/`Tip`/`Caution`...), senão `NOTE`. Título igual ao nome do tipo é descartado (redundante); título próprio vira `**Título**` na 1ª linha (`admonition-custom-title`). `aside.note`/`.callout` dentro de `main` sobrevivem à remoção de `aside` no modo article.
5. **dl**: `**termo**` e cada `dd` em parágrafos separados (linhas adjacentes se fundiriam em um parágrafo).
6. **details**: `<details>\n<summary>..</summary>\n\n<conteúdo em Markdown>\n\n</details>`.
7. **Tabela complexa** (colspan/rowspan/bloco em célula): o `<table>` sai verbatim (outerHTML, uma linha; as fixtures não têm espaço entre tags), cercado por linhas em branco, sem converter/resolver nada dentro. (A implementação atual indenta o HTML; decidir.)
8. **Pipe em célula**: `\|`, também dentro de `code` na célula (obrigatório em GFM). `|` solto em parágrafo também é escapado.
9. **video/audio/iframe**: `[Vídeo: título](src)`, áudio usa `Áudio:`, iframe usa `Vídeo:`. Sem `title`: `[Vídeo](src)` (`media-no-title`; a implementação atual escreve `[Vídeo: sem título]`).
10. **Math**: inline `$tex$`; display em bloco `$$\ntex\n$$`. MathJax v2 (`<script type="math/tex">`) exige tratar o script ANTES da limpeza da etapa 3 e descartar os quadros renderizados (`.MathJax*`). KaTeX: `.katex-html` é `aria-hidden` e some; vale a anotação `application/x-tex`.
11. **Escapes**: `* _ \` |` sempre fora de código; `[` e `]` ambos; `#` só no início de linha seguido de espaço (`C#` fica). `_` dentro de palavra: escapado (literal da SPEC) em `escape-ambiguous` (a implementação atual não escapa). Não testados: `\`, `+`, `-`, `>`, `<`.
12. **Links**: href só com fragmento (`#x`, `#`) fica como está (não absolutiza; senão os `<a id>` perdem sentido). Texto == URL (também após resolver relativo) vira `<url>`. `<base href>` relativo resolve contra a url da página.
13. **srcset**: maior `w` ou maior `x`; vale quando `src` é vazio/ausente; `src` presente prevalece.
14. **include_links**: `## Links da página`, linha em branco, lista `- [texto](url)` em ordem de aparição; deduplica pares (texto, href) idênticos; ignora âncora vazia e link só-fragmento; mantém `mailto:`.
15. **NBSP** (`&nbsp;`) vira espaço comum. Sem normalização Unicode (combinante preservado).
16. **H1 fora do conteúdo extraído** (modo article, h1 só no `<header>` fora do `main`): usa `<title>`.
17. **Espaço no fim de linha dentro de bloco de código**: não coberto (as fixtures não têm).
