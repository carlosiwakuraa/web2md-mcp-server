#!/usr/bin/env bash
# Gera web2md.mcpb (MCP Bundle para o Claude Desktop) sem sujar o working tree.
# Monta um staging em .mcpb-staging/ com: manifest.json, icon.png, dist/ e
# node_modules apenas de produção (npm ci --omit=dev), valida e empacota.
set -euo pipefail

MCPB_VERSION="2.1.2"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/.mcpb-staging"
OUT="${1:-$ROOT/web2md.mcpb}"

cd "$ROOT"

echo "==> build"
npm run build

echo "==> staging em $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp manifest.json icon.png package.json package-lock.json LICENSE README.md "$STAGE/"
cp -R dist "$STAGE/dist"
find "$STAGE/dist" -name '*.map' -delete

echo "==> dependências de produção (npm ci --omit=dev)"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

echo "==> validar manifest"
npx --yes "@anthropic-ai/mcpb@$MCPB_VERSION" validate "$STAGE/manifest.json"

echo "==> empacotar"
rm -f "$OUT"
npx --yes "@anthropic-ai/mcpb@$MCPB_VERSION" pack "$STAGE" "$OUT"

rm -rf "$STAGE"
echo "==> pronto: $OUT ($(du -h "$OUT" | cut -f1))"
