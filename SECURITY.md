# Política de segurança

## Versões suportadas

Apenas a versão mais recente publicada no npm (`@carlosiwakura/web2md-mcp-server`) recebe correções de segurança. Atualize para a última versão antes de reportar um problema.

| Versão | Suportada |
| --- | --- |
| Última versão publicada (1.x) | Sim |
| Versões anteriores | Não |

## Como reportar uma vulnerabilidade

**Não abra uma issue pública** para problemas de segurança.

Use o relato privado de vulnerabilidades do GitHub (Security Advisories):

1. Acesse <https://github.com/carlosiwakuraa/web2md-mcp-server/security/advisories/new>.
2. Descreva o problema, a versão afetada, os passos para reproduzir e o impacto esperado.

O relato é tratado de forma privada até a correção. Depois dela, o aviso é publicado com os devidos créditos (se você quiser).

## Escopo

Dentro do escopo:

- O servidor MCP (`src/`) e o que ele publica: SSRF e acesso a redes internas, redirecionamentos, limites de tamanho e tempo, tratamento de proxy e certificados, escrita de arquivos fora da pasta de saída, injeção em caminhos e nomes de arquivo, vazamento de credenciais.
- O pipeline de release (`.github/workflows/`), o pacote npm, o bundle `.mcpb` e os checksums e attestations publicados.
- Dependências diretas com vulnerabilidade explorável no uso que o servidor faz delas.

Fora do escopo:

- Conteúdo das páginas web convertidas: o servidor devolve o Markdown fiel do que a página contém, e tratar esse conteúdo como não confiável é responsabilidade do cliente e do LLM.
- Vulnerabilidades em dependências sem caminho de exploração neste projeto (inclusive em devDependencies usadas só no build).
- Problemas que exijam acesso prévio ao computador ou à conta do usuário, ou configuração deliberadamente insegura (por exemplo, desativar a verificação TLS).
- Negação de serviço por volume de requisições feitas pelo próprio cliente MCP.

## Verificando os artefatos

Cada Release traz `SHA256SUMS` e attestations de provenance do GitHub para o tarball e o `.mcpb`. Veja o passo a passo na seção "Publicação" do README.
