import { Agent, Dispatcher, ProxyAgent } from "undici";
import { effectiveEnv } from "../env.js";
import { errors } from "../errors.js";

// ---------------------------------------------------------------- configuração

export interface ProxyEnv {
  /** Valor de HTTP_PROXY / http_proxy (já sem espaços; vazio vira undefined). */
  httpProxy?: string;
  /** Valor de HTTPS_PROXY / https_proxy. */
  httpsProxy?: string;
  /** Valor bruto de NO_PROXY / no_proxy. */
  noProxy?: string;
  /** Nomes das variáveis de onde cada valor veio (para mensagens de configuração inválida). */
  httpProxyVar?: string;
  httpsProxyVar?: string;
}

function pick(env: NodeJS.ProcessEnv, lower: string, upper: string): { value?: string; name: string } {
  // A variável em minúsculas tem precedência (convenção do curl e do Node).
  for (const name of [lower, upper]) {
    const value = effectiveEnv(env[name]);
    if (value) return { value, name };
  }
  return { name: upper };
}

/** Lê HTTPS_PROXY/https_proxy, HTTP_PROXY/http_proxy e NO_PROXY/no_proxy. Variáveis vazias ou com placeholder `${...}` não resolvido contam como ausentes. */
export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnv {
  const http = pick(env, "http_proxy", "HTTP_PROXY");
  const https = pick(env, "https_proxy", "HTTPS_PROXY");
  const no = pick(env, "no_proxy", "NO_PROXY");
  return {
    httpProxy: http.value,
    httpsProxy: https.value,
    noProxy: no.value,
    httpProxyVar: http.name,
    httpsProxyVar: https.name,
  };
}

// -------------------------------------------------------------------- NO_PROXY

export interface NoProxyEntry {
  /** "*" = todos. Senão, host em minúsculas, sem "*." / "." iniciais e sem colchetes de IPv6. */
  host: string;
  port?: number;
  /** false para IPs literais (casam só por igualdade). */
  allowSubdomains: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Interpreta NO_PROXY: itens separados por vírgula/espaço. Aceita `*`, `host`,
 * `.sufixo`, `*.sufixo` e `host:porta` (inclusive `[::1]:8080`). Um domínio
 * casa com ele mesmo e com seus subdomínios.
 */
export function parseNoProxy(raw: string | undefined): NoProxyEntry[] {
  if (!raw) return [];
  const entries: NoProxyEntry[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    let item = token.trim().toLowerCase();
    if (!item) continue;
    if (item === "*") {
      entries.push({ host: "*", allowSubdomains: true });
      continue;
    }
    // Remove um esquema eventual (ex.: "https://exemplo.com").
    item = item.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");
    let host = item;
    let port: number | undefined;
    const bracket = /^\[([^\]]*)\](?::(\d+))?$/.exec(item);
    if (bracket) {
      host = bracket[1] ?? "";
      if (bracket[2]) port = Number(bracket[2]);
    } else if (item.split(":").length === 2) {
      const [h, p] = item.split(":") as [string, string];
      host = h;
      if (/^\d+$/.test(p)) port = Number(p);
      else if (p !== "") continue; // lixo depois dos dois pontos
    }
    // IPv6 sem colchetes e sem porta fica inteiro em `host`.
    host = host.replace(/^\*?\./, "");
    if (!host) continue;
    const isIp = IPV4.test(host) || host.includes(":");
    entries.push({ host, port, allowSubdomains: !isIp });
  }
  return entries;
}

function defaultPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** true se a URL deve ir direto, sem proxy, segundo as entradas de NO_PROXY. */
export function matchesNoProxy(url: URL, entries: NoProxyEntry[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = defaultPort(url);
  for (const e of entries) {
    if (e.host === "*") return true;
    if (e.port !== undefined && e.port !== port) continue;
    if (host === e.host) return true;
    if (e.allowSubdomains && host.endsWith(`.${e.host}`)) return true;
  }
  return false;
}

// ----------------------------------------------------------- escolha do proxy

/** Normaliza o valor da variável para URL ("proxy:3128" vira "http://proxy:3128"); lança erro em português se inválido. */
function toProxyUrl(value: string, varName: string): URL {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw errors.proxyConfig(varName);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw errors.proxyConfig(varName);
  }
  return url;
}

export interface ProxyChoice {
  /** URL completa do proxy, possivelmente com credenciais. NUNCA logar. */
  url: string;
  /** "host:porta" sem credenciais, seguro para mensagens. */
  label: string;
}

/** Proxy a usar para a URL de destino, ou null (conexão direta). */
export function selectProxy(target: URL, proxyEnv: ProxyEnv): ProxyChoice | null {
  const isHttps = target.protocol === "https:";
  const value = isHttps ? proxyEnv.httpsProxy : proxyEnv.httpProxy;
  if (!value) return null;
  if (matchesNoProxy(target, parseNoProxy(proxyEnv.noProxy))) return null;
  const varName = (isHttps ? proxyEnv.httpsProxyVar : proxyEnv.httpProxyVar) ?? "HTTPS_PROXY";
  const url = toProxyUrl(value, varName);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { url: url.href, label: `${url.hostname}:${port}` };
}

export function hasProxyConfigured(proxyEnv: ProxyEnv): boolean {
  return Boolean(proxyEnv.httpProxy || proxyEnv.httpsProxy);
}

// -------------------------------------------------------------------- redaction

/** Remove credenciais (user:pass@) de qualquer URL dentro do texto e os valores secretos conhecidos. */
export function redactSecrets(text: string, proxyEnv?: ProxyEnv): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
  for (const value of [proxyEnv?.httpProxy, proxyEnv?.httpsProxy]) {
    if (!value) continue;
    let url: URL;
    try {
      url = toProxyUrl(value, "");
    } catch {
      continue;
    }
    const secrets = new Set<string>();
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    for (const s of [url.username, url.password, decode(url.username), decode(url.password)]) {
      if (s) secrets.add(s);
    }
    if (url.username || url.password) {
      const pair = `${decode(url.username)}:${decode(url.password)}`;
      secrets.add(Buffer.from(pair).toString("base64"));
    }
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

// -------------------------------------------------------------------- dispatcher

/**
 * Dispatcher que escolhe, por origem de cada requisição (inclusive em
 * redirects), entre conexão direta e um ProxyAgent. Assim redirects que
 * mudam de esquema ou caem em NO_PROXY usam o caminho correto.
 */
class ProxyRouter extends Dispatcher {
  private readonly direct = new Agent();
  private readonly proxies = new Map<string, ProxyAgent>();

  constructor(private readonly proxyEnv: ProxyEnv) {
    super();
  }

  private agentFor(origin: URL): Dispatcher {
    const choice = selectProxy(origin, this.proxyEnv);
    if (!choice) return this.direct;
    let agent = this.proxies.get(choice.url);
    if (!agent) {
      // proxyTunnel:false => alvos http:// vão por forward proxy (sem CONNECT); https:// sempre usa túnel.
      agent = new ProxyAgent({ uri: choice.url, proxyTunnel: false });
      this.proxies.set(choice.url, agent);
    }
    return agent;
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    try {
      return this.agentFor(new URL(String(options.origin))).dispatch(options, handler);
    } catch (err) {
      handler.onError?.(err as Error);
      return false;
    }
  }

  close(): Promise<void>;
  close(callback: () => void): void;
  close(callback?: () => void): Promise<void> | void {
    const p = Promise.all([this.direct, ...this.proxies.values()].map((a) => a.close())).then(() => undefined);
    if (callback) {
      void p.then(callback, callback);
      return;
    }
    return p;
  }

  destroy(): Promise<void>;
  destroy(err: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(err: Error | null, callback: () => void): void;
  destroy(a?: Error | null | (() => void), b?: () => void): Promise<void> | void {
    const err = typeof a === "function" ? null : (a ?? null);
    const callback = typeof a === "function" ? a : b;
    const p = Promise.all([this.direct, ...this.proxies.values()].map((x) => x.destroy(err))).then(() => undefined);
    if (callback) {
      void p.then(callback, callback);
      return;
    }
    return p;
  }
}

const routers = new Map<string, ProxyRouter>();

/** Dispatcher (cacheado por configuração) para o ambiente de proxy; undefined se não há proxy configurado. */
export function getProxyDispatcher(proxyEnv: ProxyEnv): Dispatcher | undefined {
  if (!hasProxyConfigured(proxyEnv)) return undefined;
  const key = JSON.stringify([proxyEnv.httpProxy, proxyEnv.httpsProxy, proxyEnv.noProxy]);
  let router = routers.get(key);
  if (!router) {
    router = new ProxyRouter(proxyEnv);
    routers.set(key, router);
  }
  return router;
}

/** Fecha os dispatchers em cache (usado em testes). */
export async function closeProxyDispatchers(): Promise<void> {
  const all = [...routers.values()];
  routers.clear();
  await Promise.all(all.map((r) => r.destroy()));
}
