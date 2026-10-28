# web2md-mcp-server

Servidor MCP que recebe uma URL, faz a requisição a partir da sua máquina e devolve a página como Markdown GFM fiel à estrutura original, com frontmatter YAML.

A tool exposta se chama `web2md_fetch_markdown`. Ela não altera o servidor remoto, mas grava cada conversão em disco (ver [Pasta de saída](#pasta-de-saída)); por isso `readOnlyHint` é `false` (`destructiveHint: false`, `idempotentHint` e `openWorldHint` ficam `true`).

Desde a v1.2.0 há também a tool `web2md_fetch_markdown_batch`, que converte várias URLs de uma vez (ver [Conversão em lote](#conversão-em-lote-v120)).

## Novidades da v1.3.0

- **Proxy corporativo:** respeita `HTTPS_PROXY`, `HTTP_PROXY` e `NO_PROXY` (ver [Configuração de rede](#configuração-de-rede)).
- **Retry com backoff:** repete 429, 502, 503, 504 e erros de rede transitórios, respeitando `Retry-After`.
- **`mode: "outline"` e `section`:** devolvem só o índice de headings ou só uma seção, para gastar menos contexto.
- **Distribuição:** pacote npm (`npx -y @carlosiwakura/web2md-mcp-server`) e bundle `.mcpb` para o Claude Desktop.

## Novidades da v1.2.0

- Nova tool `web2md_fetch_markdown_batch`: converte de 1 a 20 URLs em Markdown em uma só chamada.
- O destino do conteúdo depende da **quantidade de arquivos**: só manifesto, conteúdo inline ou plano de subagentes (ver a [tabela](#o-que-acontece-conforme-a-quantidade-de-arquivos)).
- Conversão com concorrência 4, deduplicação de URLs repetidas e falha isolada por URL.
- A tool `web2md_fetch_markdown` (uma URL) continua igual.

## Instalação

Requer Node 20.18.1 ou superior (o bundle .mcpb usa o Node embutido no Claude Desktop).

### Claude Desktop (bundle .mcpb)

1. Baixe o `web2md.mcpb` da [página de releases](https://github.com/carlosiwakuraa/web2md-mcp-server/releases/latest).
2. Dê um duplo clique no arquivo (ou arraste-o para **Configurações > Extensões**) e confirme a instalação.
3. Opcional: na tela da extensão, defina a **Pasta de saída** (`WEB2MD_OUTPUT_DIR`) e o **Proxy (HTTP e HTTPS)**. O mesmo valor é repassado como `HTTPS_PROXY` e `HTTP_PROXY`, então URLs `http://` também passam pelo proxy. O campo é marcado como sensível (mascarado e armazenado de forma protegida pelo Claude Desktop), pois a URL pode conter `usuário:senha@`. Campos em branco são ignorados, inclusive se o host repassar o placeholder `${user_config.…}` sem substituí-lo.
4. Confira a integridade do arquivo baixado antes de instalar (ver [Verificar a instalação](#verificar-a-instalação)).

### Claude Code (npx)

> **Use sempre o nome COM escopo (`@carlosiwakura/...`).** O pacote `web2md-mcp-server` **sem escopo** no npm pertence a outro projeto e não tem relação com este; `npx -y web2md-mcp-server` executa código de terceiros. O pacote correto é [`@carlosiwakura/web2md-mcp-server`](https://www.npmjs.com/package/@carlosiwakura/web2md-mcp-server).

Recomendado, com **versão fixa**:

```bash
claude mcp add web2md -- npx -y @carlosiwakura/web2md-mcp-server@1.3.0
```

A versão fixa dá reprodutibilidade (todo início roda o mesmo código) e deixa a atualização sob o seu controle. Troque `1.3.0` pela versão desejada para atualizar. Sem versão (`npx -y @carlosiwakura/web2md-mcp-server`), cada início executa a última versão publicada, com dependências transitivas resolvidas na hora; é a alternativa se você prefere acompanhar as atualizações automaticamente.

### Claude Desktop e VS Code com npx

Sem o bundle, adicione o servidor na configuração. Use a mesma versão fixa (troque `1.3.0` pela versão desejada). No Claude Desktop, em `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "web2md": {
      "command": "npx",
      "args": ["-y", "@carlosiwakura/web2md-mcp-server@1.3.0"]
    }
  }
}
```

No VS Code, em `.vscode/mcp.json` (a chave raiz é `servers`):

```json
{
  "servers": {
    "web2md": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@carlosiwakura/web2md-mcp-server@1.3.0"]
    }
  }
}
```

### Verificar a instalação

- **Pacote npm.** Confira o hash de integridade publicado e as assinaturas do registro (pacotes publicados pelo workflow de release trazem provenance):

  ```bash
  npm view @carlosiwakura/web2md-mcp-server@1.3.0 dist.integrity
  npm audit signatures   # num projeto que tenha o pacote instalado
  ```

  O provenance (qual commit e workflow geraram o pacote) aparece na [página do pacote no npm](https://www.npmjs.com/package/@carlosiwakura/web2md-mcp-server), na seção de proveniência da versão.
- **Bundle .mcpb.** O `.mcpb` não é assinado. A partir da versão que incluir o workflow de release endurecido, o Release traz também o `SHA256SUMS` e uma attestation do build. Com o `web2md.mcpb` e o `SHA256SUMS` na mesma pasta:

  ```bash
  shasum -a 256 -c SHA256SUMS
  gh attestation verify web2md.mcpb --repo carlosiwakuraa/web2md-mcp-server
  ```

  Em versões anteriores esses arquivos não existem no Release; nesse caso, prefira o pacote npm com versão fixa.

### A partir do código-fonte

```bash
git clone https://github.com/carlosiwakuraa/web2md-mcp-server.git
cd web2md-mcp-server
npm install && npm run build
claude mcp add web2md -- node "$(pwd)/dist/index.js"
```

Em desenvolvimento, use `npm run dev` (roda `src/index.ts` com `tsx`). Para gerar o bundle localmente: `npm run mcpb:pack` (cria `web2md.mcpb`).

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

### Proxy

O servidor respeita as variáveis de ambiente de proxy padrão. Defina-as via `env` no seu cliente MCP, como no exemplo dos certificados acima:

| Variável | Uso |
| --- | --- |
| `HTTPS_PROXY` / `https_proxy` | Proxy para URLs `https://` |
| `HTTP_PROXY` / `http_proxy` | Proxy para URLs `http://` |
| `NO_PROXY` / `no_proxy` | Destinos que devem ir direto, sem proxy |

```json
"env": {
  "HTTPS_PROXY": "http://usuario:senha@proxy.empresa.com:3128",
  "NO_PROXY": "localhost,127.0.0.1,.intranet.empresa.com"
}
```

- **Escolha por esquema.** URLs `https://` usam só `HTTPS_PROXY` e URLs `http://` usam só `HTTP_PROXY`. Se existirem as duas grafias de uma variável, a minúscula vence. Valor vazio, só com espaços ou com placeholder `${...}` não resolvido (como `${user_config.https_proxy}` do bundle .mcpb) conta como não definido; sem nenhuma variável de proxy, o comportamento é o mesmo de antes.
- **Formato do proxy.** `http://host:porta` ou `https://host:porta`; o esquema pode ser omitido (`proxy:3128` vira `http://proxy:3128`). Credenciais na URL (`usuario:senha@`) são enviadas ao proxy como `Proxy-Authorization: Basic`. Use `%40`, `%3A` etc. para caracteres especiais na senha.
- **`NO_PROXY`.** Lista separada por vírgulas ou espaços. Aceita `*` (nunca usar proxy), nomes de host (`exemplo.com`, que também cobre `api.exemplo.com`), sufixos com ponto ou curinga (`.exemplo.com`, `*.exemplo.com`), `host:porta` (`interno.local:8080`) e IPs (`127.0.0.1`, `[::1]`). Intervalos CIDR não são suportados.
- **Redirects** são decididos a cada salto: um redirect para um host em `NO_PROXY` vai direto, e um de `http` para `https` passa a usar `HTTPS_PROXY`.
- **Erros.** Se o proxy estiver inacessível, exigir autenticação (407) ou recusar o destino, a mensagem diz isso em português (código `PROXY_ERROR`). Usuário e senha do proxy nunca aparecem em mensagens de erro nem em logs; só `host:porta`.
- **TLS.** Proxies que interceptam HTTPS (certificado próprio) exigem a CA da empresa, como descrito em "Certificados CA corporativos". Para o fetch via proxy valem as mesmas variáveis `NODE_EXTRA_CA_CERTS` / `NODE_OPTIONS=--use-system-ca`.

### Retry

Falhas transitórias são repetidas automaticamente, até **2 vezes** (3 tentativas no total):

- **HTTP** 429, 502, 503 e 504;
- **Erros de rede** transitórios: `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN` e `UND_ERR_SOCKET`.

A espera segue backoff exponencial com jitter (base de 500 ms: cerca de 0,25–0,5 s antes da 2ª tentativa e 0,5–1 s antes da 3ª). Se o servidor enviar `Retry-After` (em segundos ou como data HTTP), ele é usado no lugar do backoff. Se pedir mais de 10 s, **não há nova tentativa**: a falha HTTP é devolvida na hora (com um aviso do tempo pedido pelo servidor), para não martelar um host que já pediu pausa.

Não há retry para 4xx definitivos (404, 403 etc.), outros 5xx (como 500), timeout, conteúdo não suportado nem resposta acima do limite de tamanho. O tempo limite é **total**, somando todas as tentativas e esperas: se a próxima espera não couber no tempo restante (por exemplo, no prazo global de uma conversão em lote), a falha original é devolvida sem nova tentativa. Em caso de esgotamento, a mensagem de erro é a da última tentativa.

Na regra de domínio (URL reescrita com fallback para a original), o fallback só ocorre para 4xx definitivos (como 404) e conteúdo não suportado; um 429/5xx esgotado não dispara a busca da URL original no mesmo host. O fallback tem orçamento de tempo próprio, com o mesmo teto por URL.

## Parâmetros

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `url` | string | obrigatório | URL `http://` ou `https://` da página. |
| `mode` | `"article"` \| `"full"` \| `"outline"` | `"article"` | `article` extrai só o conteúdo principal (sem menu, rodapé e barra lateral). `full` converte o `<body>` inteiro; use quando a extração errar o conteúdo. `outline` converte como `article`, mas devolve só o índice de headings (veja [Outline e seções](#outline-e-seções)). |
| `max_chars` | inteiro (100–500000) | `50000` | Limite de caracteres por resposta. No `outline`, limita o tamanho do índice. |
| `start_index` | inteiro ≥ 0 | `0` | Posição do documento onde a resposta começa, para paginar. Não se aplica ao `outline`. |
| `include_links` | booleano | `false` | Anexa a seção `## Links da página` com os links do conteúdo. |
| `section` | string | — | Devolve só uma seção do documento: slug, texto ou id do heading. Sem ele, o `#fragmento` da URL é usado se casar com um heading. Veja [Outline e seções](#outline-e-seções). |

Além do texto, a resposta traz `structuredContent` com `{ url, source, total_chars, document_chars, next_start_index, saved_path, section, headings, headings_truncated }` (`section` e `headings` são `null` fora de `section`/`outline`).

### Pasta de saída

Toda conversão bem-sucedida é salva em `<tmpdir>/web2md-<uid>/` (pasta por usuário na temporária do sistema, modo 0700; antes era `<tmpdir>/web2md/`) ou em `$XDG_RUNTIME_DIR/web2md/` quando definido e válido. O arquivo sempre contém o **documento completo** (frontmatter + corpo), independentemente de `max_chars` e `start_index`, e `saved_path` no `structuredContent` traz o caminho absoluto.

- Nome do arquivo: `<host>_<caminho>-<hash>.md`, com `.full` antes da extensão em `mode="full"`. O hash são 16 caracteres hex (64 bits do SHA-256) da URL inteira (com query); colisão acidental entre URLs diferentes é improvável, não impossível. Os arquivos são gravados de forma atômica (0600).
- Reconverter a mesma URL e modo sobrescreve o arquivo (inclusive nas chamadas de paginação).
- Para usar outra pasta, defina `WEB2MD_OUTPUT_DIR` (caminho absoluto, ou começando com `~`; caminho relativo é recusado). Uma pasta sua com permissões abertas não é alterada (só gera aviso no `stderr`). Arquivos na pasta padrão com mais de 7 dias são apagados na primeira gravação de cada processo (`WEB2MD_RETENTION_DAYS`: dias de retenção, `0` desativa; em `WEB2MD_OUTPUT_DIR` só limpa se a variável estiver definida). No Claude Desktop: `"env": { "WEB2MD_OUTPUT_DIR": "/caminho/para/output" }`.
- Se a gravação falhar (permissão, disco cheio), a conversão continua e volta normalmente, com `saved_path: null` e o motivo no `stderr`.

### Paginação

Quando o documento passa de `max_chars`, a resposta termina com um marcador:

```
---
[Conteúdo truncado: exibidos caracteres 0–49812 de 120344. Para continuar, chame novamente com start_index=49812]
```

Chame a tool de novo com o mesmo `url` e `start_index=49812`. O frontmatter aparece só na primeira parte. Um `start_index` além do fim do documento devolve erro.

## Outline e seções

Para páginas longas, evite trazer o documento inteiro: peça o índice e depois só a seção que interessa.

1. `mode: "outline"` converte a página como `article` e devolve só o frontmatter (com `mode: outline`) e uma lista hierárquica dos headings. Cada item traz o nível, o texto, o **slug** estável e o offset inicial–final e o tamanho da seção:

   ```
   - Instalação (h2) — slug: `instalacao` — offset 412–2380 (1968 caracteres)
     - Requisitos (h3) — slug: `requisitos` — offset 1790–2380 (590 caracteres)
   ```

   O `structuredContent` traz a mesma lista em `headings` (`{ heading, level, slug, id, start, end, chars }`) e `total_chars` com o tamanho do documento completo. Os offsets são posições de caracteres no **documento completo salvo em disco** (frontmatter incluído), então valem também para ler o arquivo em `saved_path` por intervalo. O índice não é paginado (`start_index` não se aplica), mas **`max_chars` limita o tamanho do texto**: se o índice (com frontmatter) não couber, aparecem só os primeiros headings que cabem, em linhas inteiras, e o texto termina com o aviso `[Índice truncado: exibidos X de Y headings. Use section="<slug>" numa seção pai, ou aumente max_chars, para ver o restante]`. O texto nunca passa de `max_chars` (com `max_chars` muito pequeno o frontmatter também é omitido), e `total_chars`/`document_chars` continuam sendo os do documento completo. Em páginas com milhares de headings (changelogs, referências de API), `headings` no `structuredContent` é limitado a 500 itens e `headings_truncated` vira `true`; para o restante, peça `section="<slug>"` numa seção pai.
2. `section: "<slug>"` devolve só aquela seção.

Regras de `section`:

- **O que casa**, nesta ordem: slug (ou id HTML) exato; texto do heading exato, sem diferenciar maiúsculas nem acentos; prefixo do texto/slug; trecho contido. Prefixo e trecho só valem se casarem com um único heading. Uma correspondência exata vence prefixos (`API` não é ambíguo com `API REST`).
- **Slugs**: texto em minúsculas, sem acentos, com hífens (`Instalação e uso` vira `instalacao-e-uso`). Headings repetidos ganham sufixo na ordem em que aparecem (`exemplo`, `exemplo-1`, `exemplo-2`); heading sem texto aproveitável vira `secao`.
- **Fragmento da URL**: sem `section`, `https://site/pagina#instalacao` seleciona o heading cujo id HTML ou slug seja `instalacao`. Se nada casar, o fragmento é ignorado em silêncio e a página inteira é devolvida. No modo `outline` o fragmento é ignorado.
- **Extensão da seção**: o heading e tudo até o próximo heading de nível igual ou menor (as subseções entram). Headings ATX (`##`) e setext (`===`/`---`) são reconhecidos; `#` dentro de blocos de código cercados é ignorado, então um bloco nunca é cortado ao meio.
- **Frontmatter e paginação**: o frontmatter é mantido e ganha `section` e `section_slug`. `max_chars` e `start_index` paginam dentro da seção, e `total_chars`/`next_start_index` se referem a ela; `document_chars` traz o tamanho do documento completo e `section` no `structuredContent` descreve o heading escolhido. Funciona junto com `include_links` (a seção de links é uma seção própria, `links-da-pagina`).
- **Erros**: seção inexistente ou ambígua devolve `isError` com uma mensagem em português listando até 10 headings (slug, texto e nível).
- `outline` junto de `section` restringe o índice àquela seção e às suas subseções.

O arquivo salvo continua sendo sempre o documento completo. `outline` grava no mesmo arquivo do modo `article` (mesma URL, mesmo conteúdo), então não há colisão nem arquivo extra.

A tool de lote não tem `outline` nem `section`: ela trabalha com documentos inteiros (e descarta o `#fragmento` das URLs). Para índice ou seção de várias páginas, chame a tool de URL única para cada uma.

## Conversão em lote (v1.2.0)

A tool `web2md_fetch_markdown_batch` recebe várias URLs, converte cada uma para Markdown (mesmo pipeline da tool de URL única) e grava um arquivo `.md` completo por página na [pasta de saída](#pasta-de-saída). O que volta ao contexto do modelo depende de `return_content` e da quantidade de arquivos convertidos.

A conversão é **determinística**: é feita pelo servidor, sem chamar modelo, e **não gasta tokens**. Só gasta tokens o conteúdo que você decide trazer ao contexto, e é para controlar isso que existe a lógica por quantidade de arquivos.

### Parâmetros do lote

| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `urls` | array de strings (1–20) | obrigatório | URLs `http://` ou `https://`. URLs repetidas são convertidas uma única vez; o fragmento `#...` é removido antes de comparar. |
| `mode` | `"article"` \| `"full"` | `"article"` | Modo de extração aplicado a todas as URLs (mesmo significado da tool de URL única). |
| `include_links` | booleano | `false` | Anexa a seção `## Links da página` em cada documento. |
| `return_content` | booleano | `true` | `false` salva tudo em disco e devolve só o manifesto, sem conteúdo no contexto. `true` traz o conteúdo conforme a tabela abaixo. |
| `inline_max_files` | inteiro (1–20) | `3` | Com `return_content=true`, quantidade máxima de arquivos convertidos que ainda vêm inline. Acima disso, a resposta é um plano de subagentes. |
| `files_per_agent` | inteiro (1–20) | `5` | No plano de subagentes, quantos arquivos cada subagente recebe. `1` = um subagente por arquivo. |
| `objective` | string (até 2000 caracteres) | não definido | O que você quer das páginas (ex.: "comparar as opções de autenticação"). É repassado aos subagentes para guiar a extração. |
| `max_chars` | inteiro (100–500000) | `50000` | Só no modo inline: máximo de caracteres de cada documento no contexto. Um documento maior termina com um marcador que aponta para o arquivo salvo completo; o lote não tem `start_index`, então para ler o restante leia o `saved_path`. |

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
- **Deduplicação:** as URLs são normalizadas sem o fragmento `#...` antes de comparar; repetidas são convertidas uma única vez. URLs que convergem para o mesmo arquivo final contam como um só arquivo.
- **Falha isolada por URL:** um erro (404, timeout, página que depende de JavaScript etc.) marca só aquele item como `error`, com a mensagem em `error`; as demais URLs seguem normalmente e só as convertidas entram no plano. Falha ao salvar o arquivo também conta como erro daquele item: nada fica `ok` sem arquivo salvo.
- **Prazo global de 50 s:** URLs não concluídas até lá viram erro `Prazo do lote ... esgotado` e o resultado parcial é devolvido; os arquivos já salvos permanecem.
- **Nomes de arquivo:** iguais aos da tool de URL única (`<host>_<caminho>-<hash>.md`, com `.full` em `mode="full"`). O `slug` de cada item é o nome do arquivo sem `.md` e serve de identificador, inclusive como nome do subagente.
- **Pasta de saída:** a mesma da tool de URL única; para trocar, defina `WEB2MD_OUTPUT_DIR`. O arquivo salvo contém sempre o documento completo, independentemente de `max_chars`.

## Publicação

Passo a passo para mantenedores (a versão fica em `package.json`, `manifest.json`, `server.json` — em dois campos — e `SERVER_VERSION` em `src/constants.ts`):

1. Atualize a versão nesses lugares, rode `npm install --package-lock-only` e confira `npm run build && npm test`.
2. Abra um PR e faça o merge na `master`. **Não é preciso criar a tag à mão:** o workflow `.github/workflows/release.yml` roda a cada push na `master` (e no `workflow_dispatch`, que só publica se executado na `master`) e, se a tag `v<versão>` ainda não existe, executa 4 jobs com privilégios mínimos:
   - `detect`: lê a versão, confere que ela é a mesma em todos os arquivos e vê se a tag já existe. Se existir (merge sem bump de versão), o workflow termina aqui.
   - `build`: sem segredos e com `GITHUB_TOKEN` somente leitura. Roda `npm ci --ignore-scripts`, build e testes, gera o tarball (`npm pack`), o `web2md.mcpb` e o `SHA256SUMS`, cria attestations de provenance (tarball e `.mcpb`) e envia tudo como artefato.
   - `publish`: usa o environment `npm-release` (precisa da aprovação de um revisor) e publica no npm, com `--provenance`, o tarball exato gerado no `build`, sem rodar scripts. Só este passo recebe o `NPM_TOKEN`. Se a versão já está no npm, o publish é pulado.
   - `release`: cria a tag e o GitHub Release com o tarball, o `web2md.mcpb` e o `SHA256SUMS`. Se a Release já existe, apenas reenvia os arquivos.
3. Se algum job falhar, rode "Re-run" (ou `workflow_dispatch` na `master`): o publish é pulado quando a versão já está no npm e o release é idempotente.
4. Publicação manual, se preferir: `npm login` e `npm publish` (o `prepublishOnly` limpa, compila e testa; `publishConfig.access` já é `public`).

### Verificar um release

Baixe os arquivos do GitHub Release e confira:

```bash
# checksums (tarball, .mcpb e SHA256SUMS na mesma pasta)
sha256sum --check SHA256SUMS            # no macOS: shasum -a 256 --check SHA256SUMS

# attestation de provenance (GitHub CLI)
gh attestation verify web2md.mcpb --repo carlosiwakuraa/web2md-mcp-server
gh attestation verify carlosiwakura-web2md-mcp-server-<versão>.tgz --repo carlosiwakuraa/web2md-mcp-server

# pacote instalado a partir do npm: assinaturas e provenance do registro
npm audit signatures
```

### Configurações do repositório (manual)

O que o mantenedor precisa ativar no GitHub (Settings). O workflow não consegue aplicar nada disso sozinho:

- **Ruleset da branch `master`:** exigir PR (com revisão de Code Owners, ver `.github/CODEOWNERS`), exigir status checks, bloquear force-push e exclusão da branch.
- **Ruleset de tags `v*`:** bloquear atualização e exclusão de tags de versão, e restringir a criação (o `release` cria a tag com o `GITHUB_TOKEN`; inclua o GitHub Actions na lista de bypass, se a criação for restrita).
- **Environment `npm-release`** (Settings > Environments): "Required reviewers" com o mantenedor, e "Deployment branches and tags" restrito à `master`. Sem este environment o job `publish` não tem acesso ao secret.
- **Secret `NPM_TOKEN` apenas nesse environment:** use um token granular do npm (permissão de publicar só neste pacote/escopo, com expiração) e não o cadastre como secret do repositório.
- **Migração futura para npm Trusted Publishing (OIDC):** depois que o pacote existir no npm (a primeira publicação precisa do token), configure o Trusted Publisher do pacote em npmjs.com (repositório `carlosiwakuraa/web2md-mcp-server`, workflow `release.yml`, environment `npm-release`), garanta npm >= 11.5.1 no job `publish` (por exemplo `npm install -g npm@^11.5.1`), remova o `NPM_TOKEN` e o `NODE_AUTH_TOKEN` e apague o secret.
- Recomendados: Dependabot alerts e security updates, secret scanning com push protection, e "Private vulnerability reporting" (usado pelo `SECURITY.md`).

### MCP Registry (próximo passo)

O repositório já tem o `server.json` e o `mcpName` (`io.github.carlosiwakuraa/web2md-mcp-server`) no `package.json`. Depois que a versão estiver no npm: instale o `mcp-publisher`, rode `mcp-publisher login github` e `mcp-publisher publish` na raiz do repositório.

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
- `section` inexistente ou ambígua (a mensagem lista os headings disponíveis).

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
