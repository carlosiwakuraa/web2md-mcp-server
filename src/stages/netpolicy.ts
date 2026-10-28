import dns from "node:dns";
import net from "node:net";
import { Agent, type Dispatcher } from "undici";
import { effectiveEnv } from "../env.js";
import { Web2mdError } from "../errors.js";

/**
 * Política de rede (opt-in) contra SSRF: bloqueio de destinos privados, allowlist e blocklist de hosts.
 * Tudo é desligado por padrão para não quebrar o uso em intranets.
 */

// ---------------------------------------------------------------- variáveis de ambiente

export const BLOCK_PRIVATE_ENV = "WEB2MD_BLOCK_PRIVATE_NETWORKS";
export const ALLOWED_HOSTS_ENV = "WEB2MD_ALLOWED_HOSTS";
export const BLOCKED_HOSTS_ENV = "WEB2MD_BLOCKED_HOSTS";
export const ALLOW_DOWNGRADE_ENV = "WEB2MD_ALLOW_HTTPS_DOWNGRADE";

/** Mensagem única para bloqueio e para destino inalcançável com a política ativa: não revela o motivo. */
export const BLOCKED_MESSAGE = "Destino bloqueado pela política de rede do servidor ou inacessível";

/** Código interno do erro de bloqueio (viaja na cadeia de `cause` do fetch). */
export const BLOCKED_CODE = "W2M_BLOCKED";

export function blockedError(): Web2mdError {
  return new Web2mdError("NETWORK_ERROR", BLOCKED_MESSAGE);
}

// ---------------------------------------------------------------- endereços IP

function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i] as string;
    if (part.length > 1 && part.startsWith("0")) return null; // ambíguo (octal): recusa
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function parseIPv6(input: string): number[] | null {
  let s = input.split("%")[0] ?? "";
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (p: string | undefined) => (p === undefined || p === "" ? [] : p.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  let all: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    all = head;
  } else {
    if (head.length + rest.length > 7) return null;
    all = [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest];
  }
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** [base, comprimento do prefixo] de faixas IPv4 não globais (privadas, loopback, link-local, CGNAT, multicast, reservadas). */
const V4_NON_PUBLIC: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isNonPublicV4(addr: number): boolean {
  for (const [base, bits] of V4_NON_PUBLIC) {
    const b = parseIPv4(base) as number;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((addr & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

function isNonPublicV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const v4 = (hi: number, lo: number) => ((hi << 16) | lo) >>> 0;
  // ::/96 (inclui :: e ::1) e IPv4-compatível: reservado.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:a.b.c.d (IPv4-mapeado): vale a regra do IPv4 embutido.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isNonPublicV4(v4(g6, g7));
  // 64:ff9b::/96 (NAT64): IPv4 embutido; 64:ff9b:1::/48 é de uso local.
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true;
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isNonPublicV4(v4(g6, g7));
  }
  // 2002::/16 (6to4): IPv4 nos bits 16–47.
  if (g0 === 0x2002) return isNonPublicV4(v4(g1, g2));
  // 2001::/32 (Teredo) e 2001:db8::/32 (documentação).
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) return true;
  // 100::/64 (descarte).
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 (site-local, obsoleto)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
  return false;
}

/** true se o IP (v4 ou v6, em texto) não é um endereço público roteável. Texto que não é IP conta como privado (falha fechada). */
export function isPrivateAddress(ip: string): boolean {
  const text = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(text);
  if (v4 !== null) return isNonPublicV4(v4);
  const v6 = parseIPv6(text);
  if (v6) return isNonPublicV6(v6);
  return true;
}

// ---------------------------------------------------------------- política

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface NetworkPolicy {
  /** Bloqueia destinos privados (por nome, por IP literal e pelo IP resolvido na conexão). */
  blockPrivate: boolean;
  /** Se não vazia, só estes hosts (e subdomínios) são permitidos. */
  allowedHosts: string[];
  blockedHosts: string[];
  allowHttpsDowngrade: boolean;
  /** Alguma restrição de destino ativa: as mensagens de falha de rede passam a ser genéricas. */
  restricted: boolean;
  /** Resolve nomes na conexão (injetável em testes). */
  resolver: Resolver;
  /** Decide se um IP RESOLVIDO é privado (injetável em testes; IPs literais usam sempre isPrivateAddress). */
  isPrivateResolved: (ip: string) => boolean;
}

export interface PolicyHooks {
  resolver?: Resolver;
  isPrivateResolved?: (ip: string) => boolean;
}

const defaultResolver: Resolver = async (hostname) => {
  const all = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family }));
};

function truthy(value: string | undefined): boolean {
  const v = effectiveEnv(value)?.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Lista separada por vírgula/espaço: aceita `exemplo.com`, `.exemplo.com`, `*.exemplo.com`, `https://exemplo.com/x` e `exemplo.com:8080` (porta ignorada). */
export function parseHostList(raw: string | undefined): string[] {
  const value = effectiveEnv(raw);
  if (!value) return [];
  const out: string[] = [];
  for (const token of value.split(/[\s,]+/)) {
    let item = token.trim().toLowerCase();
    if (!item) continue;
    item = item.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
    const bracket = /^\[([^\]]*)\](?::\d+)?$/.exec(item);
    if (bracket) item = bracket[1] ?? "";
    else if (item.split(":").length === 2) item = item.split(":")[0] ?? "";
    item = item.replace(/^\*?\./, "").replace(/\.$/, "");
    if (item) out.push(item);
  }
  return out;
}

export function readNetworkPolicy(env: NodeJS.ProcessEnv = process.env, hooks: PolicyHooks = {}): NetworkPolicy {
  const blockPrivate = truthy(env[BLOCK_PRIVATE_ENV]);
  const allowedHosts = parseHostList(env[ALLOWED_HOSTS_ENV]);
  const blockedHosts = parseHostList(env[BLOCKED_HOSTS_ENV]);
  return {
    blockPrivate,
    allowedHosts,
    blockedHosts,
    allowHttpsDowngrade: truthy(env[ALLOW_DOWNGRADE_ENV]),
    restricted: blockPrivate || allowedHosts.length > 0 || blockedHosts.length > 0,
    resolver: hooks.resolver ?? defaultResolver,
    isPrivateResolved: hooks.isPrivateResolved ?? isPrivateAddress,
  };
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function matchesHostList(host: string, list: string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isLocalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    host === "internal" ||
    host.endsWith(".internal")
  );
}

/**
 * Valida o destino pelo que está na própria URL (nome e IP literal). Chamada em CADA salto de redirect.
 * A resolução de DNS é validada à parte, na conexão (ver getGuardedLookup).
 */
export function checkDestination(url: URL, policy: NetworkPolicy): void {
  if (!policy.restricted) return;
  const host = normalizeHost(url.hostname);
  if (policy.allowedHosts.length > 0 && !matchesHostList(host, policy.allowedHosts)) throw blockedError();
  if (policy.blockedHosts.length > 0 && matchesHostList(host, policy.blockedHosts)) throw blockedError();
  if (policy.blockPrivate) {
    if (isLocalName(host)) throw blockedError();
    if (net.isIP(host) !== 0 && isPrivateAddress(host)) throw blockedError();
  }
}

// ---------------------------------------------------------------- lookup protegido (DNS rebinding)

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
export type GuardedLookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;

const lookupCache = new WeakMap<Resolver, WeakMap<(ip: string) => boolean, GuardedLookup>>();
const lookupIds = new WeakMap<GuardedLookup, number>();
let nextLookupId = 1;

/** Identificador estável de um lookup (para chaves de cache). */
export function lookupId(lookup: GuardedLookup): number {
  let id = lookupIds.get(lookup);
  if (id === undefined) {
    id = nextLookupId++;
    lookupIds.set(lookup, id);
  }
  return id;
}

/**
 * Lookup para o `connect` do undici: resolve o nome, recusa a conexão se QUALQUER endereço devolvido for
 * privado e devolve só os endereços já validados, que são os usados pela conexão (sem segunda resolução).
 */
export function getGuardedLookup(policy: NetworkPolicy): GuardedLookup {
  const { resolver, isPrivateResolved } = policy;
  let byPrivate = lookupCache.get(resolver);
  if (!byPrivate) {
    byPrivate = new WeakMap();
    lookupCache.set(resolver, byPrivate);
  }
  const cached = byPrivate.get(isPrivateResolved);
  if (cached) return cached;

  const lookup: GuardedLookup = (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error("sem endereços"), { code: "ENOTFOUND" }) as NodeJS.ErrnoException);
          return;
        }
        if (addresses.some((a) => isPrivateResolved(a.address))) {
          callback(Object.assign(new Error("destino bloqueado"), { code: BLOCKED_CODE }) as NodeJS.ErrnoException);
          return;
        }
        const wanted = options?.family === 4 || options?.family === 6 ? options.family : 0;
        const usable = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
        if (usable.length === 0) {
          callback(Object.assign(new Error("sem endereços"), { code: "ENOTFOUND" }) as NodeJS.ErrnoException);
          return;
        }
        if (options?.all) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, usable[0]!.address, usable[0]!.family);
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException),
    );
  };
  byPrivate.set(isPrivateResolved, lookup);
  return lookup;
}

const guardedAgents = new Map<GuardedLookup, Agent>();

/** Agent direto (sem proxy) cujo connect usa o lookup protegido. */
export function getGuardedAgent(lookup: GuardedLookup): Dispatcher {
  let agent = guardedAgents.get(lookup);
  if (!agent) {
    agent = new Agent({ connect: { lookup: lookup as unknown as net.LookupFunction } });
    guardedAgents.set(lookup, agent);
  }
  return agent;
}

/** Fecha os agents protegidos em cache (usado em testes). */
export async function closeGuardedAgents(): Promise<void> {
  const all = [...guardedAgents.values()];
  guardedAgents.clear();
  await Promise.all(all.map((a) => a.destroy()));
}
