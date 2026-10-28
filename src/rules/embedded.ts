import type TurndownService from "turndown";
import { collapseLineBreaks } from "../text-util.js";
import type { RuleRegistrar } from "../types.js";
import { safeMediaUrl } from "../url-safety.js";

/**
 * Elementos "embutidos":
 *  - details/summary, sup/sub/kbd/mark -> HTML embutido (sem equivalente em Markdown)
 *  - video/audio/iframe -> link `[Vídeo: título](src)`
 */

export interface MediaInfo {
  label: "Vídeo" | "Áudio" | "Iframe";
  title: string;
  href: string;
}

const NO_TITLE = "sem título";

const VIDEO_HOSTS =
  /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|wistia\.(com|net)|loom\.com|vidyard\.com|streamable\.com|brightcove\.net|jwplatform\.com|jwplayer\.com|bitchute\.com|rumble\.com|peertube\.[a-z]+|ted\.com|facebook\.com|fb\.watch)$/i;
const AUDIO_HOSTS = /(^|\.)(open\.spotify\.com|spotify\.com|soundcloud\.com|bandcamp\.com|anchor\.fm|podbean\.com|buzzsprout\.com|mixcloud\.com)$/i;

const FALLBACK_TEXT = /your browser|seu navegador|not support|n[aã]o suporta|enable javascript|download the|baixe/i;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function firstAttr(el: Element, names: string[]): string {
  for (const n of names) {
    const v = el.getAttribute(n);
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function isUsableUrl(raw: string): boolean {
  if (!raw) return false;
  const lower = raw.trim().toLowerCase();
  return !(lower === "about:blank" || lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("blob:"));
}

function findSrc(el: Element): string {
  const direct = firstAttr(el, ["src", "data-src", "data-lazy-src", "data-original"]);
  if (isUsableUrl(direct)) return direct;
  if (el.nodeName.toLowerCase() !== "iframe") {
    const sources = el.querySelectorAll("source");
    for (let i = 0; i < sources.length; i++) {
      const s = firstAttr(sources[i]!, ["src", "data-src"]);
      if (isUsableUrl(s)) return s;
    }
  }
  return "";
}

function findTitle(el: Element): string {
  const attr = firstAttr(el, ["title", "aria-label", "data-title"]);
  if (attr) return collapse(attr);
  const track = el.querySelector("track[label]");
  if (track) {
    const l = collapse(track.getAttribute("label") ?? "");
    if (l) return l;
  }
  // Texto interno é fallback ("Seu navegador não suporta vídeo"): só serve se parecer um título.
  const inner = collapse(el.textContent ?? "");
  if (inner && inner.length <= 80 && !FALLBACK_TEXT.test(inner)) return inner;
  return NO_TITLE;
}

function labelFor(el: Element, href: string): MediaInfo["label"] {
  const tag = el.nodeName.toLowerCase();
  if (tag === "video") return "Vídeo";
  if (tag === "audio") return "Áudio";
  try {
    const u = new URL(href);
    if (VIDEO_HOSTS.test(u.hostname) || /(^|\.)player\./i.test(u.hostname) || /\/player\b/i.test(u.pathname)) return "Vídeo";
    if (AUDIO_HOSTS.test(u.hostname)) return "Áudio";
  } catch {
    /* URL relativa/inválida: Iframe */
  }
  return "Iframe";
}

/** Descreve um video/audio/iframe, ou null quando não há URL utilizável. */
export function mediaInfo(el: Element, resolveUrl: (raw: string) => string): MediaInfo | null {
  const raw = findSrc(el);
  if (!raw) return null;
  // Allowlist (http/https) sobre a URL resolvida: `java\tscript:`, `data:`, `file:` etc. não passam.
  const href = safeMediaUrl(resolveUrl(raw));
  if (!href) return null;
  return { label: labelFor(el, href), title: findTitle(el), href };
}

function escapeLinkText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/([[\]])/g, "\\$1");
}

function encodeDestination(url: string): string {
  return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/</g, "%3C").replace(/>/g, "%3E");
}

export function formatMediaLink(info: MediaInfo): string {
  const label = info.title === NO_TITLE ? info.label : `${info.label}: ${escapeLinkText(info.title)}`;
  return `[${label}](${encodeDestination(info.href)})`;
}

/** Converte `summary` em uma linha, sem Markdown de bloco. */
function oneLine(s: string): string {
  return collapseLineBreaks(s).trim();
}

function isInsideDetails(node: Node): boolean {
  const p = node.parentNode;
  return !!p && p.nodeName.toLowerCase() === "details";
}

export const registerEmbeddedRules: RuleRegistrar = (td: TurndownService, ctx) => {
  // sup, sub, kbd, mark: HTML embutido com o interior já convertido (Markdown inline).
  td.addRule("web2md-inline-html", {
    filter: ["sup", "sub", "kbd", "mark"],
    replacement: (content, node) => {
      if (!content.trim()) return "";
      const tag = node.nodeName.toLowerCase();
      return `<${tag}>${content}</${tag}>`;
    },
  });

  td.addRule("web2md-summary", {
    filter: (node) => node.nodeName.toLowerCase() === "summary" && isInsideDetails(node),
    replacement: (content) => {
      const text = oneLine(content);
      return text ? `\n\n<summary>${text}</summary>\n\n` : "";
    },
  });

  td.addRule("web2md-details", {
    filter: "details",
    replacement: (content, node) => {
      const open = (node as Element).hasAttribute("open") ? " open" : "";
      let body = content.trim();
      if (!body) return "";
      if (!body.startsWith("<summary>")) body = `<summary>Details</summary>\n\n${body}`;
      return `\n\n<details${open}>\n${body}\n\n</details>\n\n`;
    },
  });

  td.addRule("web2md-media", {
    filter: ["video", "audio", "iframe"],
    replacement: (content, node) => {
      const info = mediaInfo(node as Element, (raw) => ctx.resolveUrl(raw));
      if (info) return `\n\n${formatMediaLink(info)}\n\n`;
      // Sem src: descarta o elemento, mas preserva o texto de fallback interno.
      const text = content.trim();
      return text ? `\n\n${text}\n\n` : "";
    },
  });
};
