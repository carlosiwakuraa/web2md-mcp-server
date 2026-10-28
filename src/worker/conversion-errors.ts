import { Web2mdError, type ErrorCode } from "../errors.js";

/** Erros do isolamento de conversão (worker_threads). */
const code = (c: ErrorCode) => c;

const mb = (bytes: number) => (bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 });

export const conversionErrors = {
  htmlTooLarge: (bytes: number, limit: number, envName: string) =>
    new Web2mdError(
      code("CONVERSION_LIMIT"),
      `O HTML da página tem ${mb(bytes)} MB, acima do limite de conversão de ${mb(limit)} MB. ` +
        `Não foi convertida para proteger o servidor (o limite pode ser ajustado em ${envName}).`,
    ),
  tooManyNodes: (limit: number) =>
    new Web2mdError(
      code("CONVERSION_LIMIT"),
      `A página tem elementos HTML demais (limite de ${limit.toLocaleString("pt-BR")} nós). Não foi convertida para proteger o servidor.`,
    ),
  tooDeep: (limit: number) =>
    new Web2mdError(
      code("CONVERSION_LIMIT"),
      `O HTML da página tem aninhamento excessivo (limite de profundidade ${limit}). Não foi convertida para proteger o servidor.`,
    ),
  stackOverflow: () =>
    new Web2mdError(
      code("CONVERSION_LIMIT"),
      "O HTML da página tem aninhamento profundo demais para converter. Não foi convertida para proteger o servidor.",
    ),
  memory: () =>
    new Web2mdError(
      code("CONVERSION_LIMIT"),
      "A conversão excedeu o limite de memória e foi interrompida (página grande ou malformada demais).",
    ),
  timeout: (ms: number) =>
    new Web2mdError(
      code("CONVERSION_TIMEOUT"),
      `A conversão excedeu ${Math.round(ms / 1000)} s e foi interrompida (página grande ou malformada demais).`,
    ),
  busy: () =>
    new Web2mdError(
      code("CONVERSION_LIMIT"),
      "Servidor ocupado: há conversões demais na fila. Tente novamente em instantes.",
    ),
  aborted: () => new Web2mdError(code("CONVERSION_ABORTED"), "Conversão cancelada (prazo esgotado)."),
};
