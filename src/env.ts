/**
 * Valor efetivo de uma variável de ambiente, ou undefined.
 *
 * Retorna undefined para ausente, vazio, só espaços e para placeholder não
 * resolvido (`${user_config.xxx}`): quando um campo opcional do manifest .mcpb
 * fica em branco, alguns hosts repassam o literal em vez de uma string vazia.
 */
export function effectiveEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("${")) return undefined;
  return trimmed;
}
