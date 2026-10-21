/**
 * Etapa 3 — limpeza do DOM (muta o documento).
 *
 * Decisões:
 * - `script[type^="math/"]` (MathJax v2: `math/tex`, `math/mml`) NÃO é removido, pois carrega
 *   o TeX original que a regra de matemática usa.
 * - `svg` é sempre removido (spec). `math` é preservado.
 * - `hidden` / `aria-hidden="true"` são removidos, EXCETO elementos de matemática
 *   (KaTeX `.katex*`, MathJax `.MathJax*`/`mjx-container`, `<math>`, `<annotation>`), seus
 *   descendentes e seus ancestrais (o `.katex-html` de KaTeX tem aria-hidden mas fica; o
 *   conversor decide o que usar — normalmente a anotação TeX de `.katex-mathml`).
 * - `<form>` é removido, exceto quando envolve o conteúdo da página (ASP.NET WebForms: um único
 *   <form> em volta do body): nesse caso é "desembrulhado" (filhos sobem, o form some).
 * - `iframe` de anúncio é removido; iframes de conteúdo (YouTube, Vimeo, player, embed…) ficam.
 */

const MATH_SELECTOR = [
  "math",
  "annotation",
  "annotation-xml",
  ".katex",
  ".katex-display",
  ".katex-mathml",
  ".katex-html",
  "mjx-container",
  "mjx-assistive-mml",
  '[class*="MathJax"]',
  '[id^="MathJax"]',
  ".mwe-math-element",
  '[data-mathml]',
  'script[type^="math/"]',
].join(",");

/** Fragmentos que identificam rede de anúncios em qualquer posição. */
const AD_SUBSTRINGS = [
  "doubleclick",
  "googlesyndication",
  "adsystem",
  "adservice",
  "adsbygoogle",
  "sponsor",
];

/** Tokens (separados por não-alfanuméricos) que indicam anúncio. */
const AD_TOKENS = new Set([
  "ad",
  "ads",
  "adv",
  "advert",
  "adverts",
  "advertisement",
  "advertisements",
  "advertising",
  "adframe",
  "adslot",
  "adunit",
  "adbanner",
]);

/** Iframes de conteúdo — preservados mesmo que algum token pareça anúncio. */
const CONTENT_IFRAME =
  /youtube|youtu\.be|vimeo|dailymotion|twitch|spotify|soundcloud|codepen|codesandbox|player|embed|video/i;

function textLength(el: Element): number {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function hasAdToken(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((t) => AD_TOKENS.has(t));
}

function isAdIframe(el: Element): boolean {
  const src = el.getAttribute("src") ?? el.getAttribute("data-src") ?? "";
  const id = el.getAttribute("id") ?? "";
  const cls = el.getAttribute("class") ?? "";
  const all = `${src} ${id} ${cls}`.toLowerCase();
  if (AD_SUBSTRINGS.some((s) => all.includes(s))) return true;
  // iframe de conteúdo (player/embed) vence tokens genéricos como "ad"
  if (CONTENT_IFRAME.test(src)) return false;
  return hasAdToken(src) || hasAdToken(id) || hasAdToken(cls);
}

function isMathProtected(el: Element): boolean {
  return el.matches(MATH_SELECTOR) || el.closest(MATH_SELECTOR) !== null || el.querySelector(MATH_SELECTOR) !== null;
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** Etapa 3: remove script/style/noscript/svg/form/button/iframe de anúncio/hidden/aria-hidden. Muta o documento. */
export function cleanDom(doc: Document): void {
  // script (menos MathJax v2), style, noscript, svg, button
  for (const el of Array.from(doc.querySelectorAll("script, style, noscript, svg, button"))) {
    if (el.tagName.toLowerCase() === "script" && /^math\//i.test(el.getAttribute("type") ?? "")) continue;
    el.remove();
  }

  // campos hidden de formulário (ex.: __VIEWSTATE) — sem texto, só ruído
  for (const el of Array.from(doc.querySelectorAll('input[type="hidden" i]'))) el.remove();

  // iframes de anúncio
  for (const el of Array.from(doc.querySelectorAll("iframe"))) {
    if (isAdIframe(el)) el.remove();
  }

  // hidden / aria-hidden (preservando matemática)
  for (const el of Array.from(doc.querySelectorAll('[hidden], [aria-hidden="true" i]'))) {
    if (!doc.contains(el)) continue; // já removido junto com um ancestral
    const tag = el.tagName.toLowerCase();
    if (tag === "html" || tag === "body") continue;
    if (isMathProtected(el)) continue;
    el.remove();
  }

  // form: remover, exceto se envolve o conteúdo da página (então desembrulha)
  const bodyLen = doc.body ? textLength(doc.body) : 0;
  for (const form of Array.from(doc.querySelectorAll("form"))) {
    if (!doc.contains(form)) continue;
    const wrapsPage =
      form.querySelector("main, article, [role='main']") !== null ||
      (bodyLen > 0 && textLength(form) >= 500 && textLength(form) >= bodyLen * 0.5);
    if (wrapsPage) unwrap(form);
    else form.remove();
  }
}
