/**
 * Grupos de abas ("npm / pnpm / yarn", "Windows / macOS / Linux") de sites de documentação.
 *
 * Sem tratamento, o HTML perde informação: as abas inativas vêm com `hidden` (Docusaurus, Starlight) e
 * somem em cleanDom, e os rótulos viram uma linha solta ou uma lista de links, desligados dos blocos.
 * `normalizeTabs` roda ANTES da limpeza e reescreve cada grupo reconhecido como uma sequência de
 * painéis, cada um precedido de um parágrafo em negrito com o rótulo da aba:
 *
 *   **npm**
 *   ```sh ... ```
 *   **yarn**
 *   ```sh ... ```
 *
 * Reconhecidos:
 *  - ARIA genérico (`[role=tablist]` + `[role=tab]` + `[role=tabpanel]`): Docusaurus, Starlight etc.;
 *  - VitePress (`.vp-code-group`);
 *  - MkDocs Material (`.tabbed-set`).
 *
 * Conservador: se rótulos e painéis não casam um a um, o grupo fica intocado. Grupos aninhados são
 * tratados do mais interno para o mais externo.
 */

const MAX_SCOPE_DEPTH = 4;

function compactText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function labelOf(el: Element): string {
  return compactText(el) || (el.getAttribute("data-title") ?? el.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim();
}

/** Filhos diretos de `el` que casam com `selector` (sem `:scope`, que o jsdom nem sempre resolve). */
function childrenMatching(el: Element, selector: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstElementChild; n; n = n.nextElementSibling) if (n.matches(selector)) out.push(n);
  return out;
}

/** Revela o painel e insere o rótulo da aba logo antes dele. */
function labelPanel(panel: Element, label: string): void {
  panel.removeAttribute("hidden");
  if (panel.getAttribute("aria-hidden") === "true") panel.removeAttribute("aria-hidden");
  panel.removeAttribute("role"); // um grupo externo não pode mais tomar este painel por seu
  if (!label || !panel.parentNode) return;
  const doc = panel.ownerDocument;
  const p = doc.createElement("p");
  const strong = doc.createElement("strong");
  strong.textContent = label;
  p.appendChild(strong);
  panel.parentNode.insertBefore(p, panel);
}

// ------------------------------------------------------------------- ARIA

/** Painel de cada aba: por `aria-controls`, por `aria-labelledby` ou, com contagens iguais, por posição. */
function pairAria(tabs: Element[], panels: Element[]): Element[] | null {
  const used = new Set<Element>();
  const paired: Element[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const controls = tab.getAttribute("aria-controls");
    const tabId = tab.getAttribute("id");
    let panel: Element | undefined = controls ? panels.find((p) => p.getAttribute("id") === controls) : undefined;
    if (!panel && tabId) panel = panels.find((p) => (p.getAttribute("aria-labelledby") ?? "").split(/\s+/).includes(tabId));
    if (!panel && panels.length === tabs.length) panel = panels[i];
    if (!panel || used.has(panel)) return null;
    used.add(panel);
    paired.push(panel);
  }
  return paired;
}

function normalizeAriaTabs(doc: Document): void {
  // Ordem inversa: os grupos internos (que vêm depois no documento) são resolvidos primeiro.
  const lists = Array.from(doc.querySelectorAll('[role="tablist"]')).reverse();
  for (const list of lists) {
    if (!doc.contains(list)) continue;
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    if (tabs.length === 0) continue;

    let panels: Element[] = [];
    let scope: Element | null = list.parentElement;
    for (let depth = 0; scope && depth < MAX_SCOPE_DEPTH; depth++, scope = scope.parentElement) {
      panels = Array.from(scope.querySelectorAll('[role="tabpanel"]')).filter((p) => !list.contains(p));
      if (panels.length >= tabs.length) break;
    }
    if (panels.length < tabs.length) continue;

    const paired = pairAria(tabs, panels);
    if (!paired) continue;
    paired.forEach((panel, i) => labelPanel(panel, labelOf(tabs[i]!)));
    list.remove();
  }
}

// ------------------------------------------------------- grupos por posição

interface PositionalGroup {
  /** Contêiner do grupo. */
  group: string;
  /** Filho direto do grupo que contém os rótulos. */
  labels: string;
  /** Rótulo de cada aba, dentro de `labels`. */
  label: string;
  /** Filho direto do grupo que contém os painéis. */
  panels: string;
  /** Painel de cada aba, dentro de `panels`. */
  panel: string;
}

const POSITIONAL_GROUPS: PositionalGroup[] = [
  { group: ".vp-code-group", labels: ".tabs", label: "label", panels: ".blocks", panel: "*" },
  { group: ".tabbed-set", labels: ".tabbed-labels", label: "label", panels: ".tabbed-content", panel: ".tabbed-block" },
];

function normalizePositionalTabs(doc: Document, spec: PositionalGroup): void {
  const groups = Array.from(doc.querySelectorAll(spec.group)).reverse();
  for (const group of groups) {
    if (!doc.contains(group)) continue;
    const labelBox = childrenMatching(group, spec.labels)[0];
    const panelBox = childrenMatching(group, spec.panels)[0];
    if (!labelBox || !panelBox) continue;
    const labels = childrenMatching(labelBox, spec.label);
    const panels = childrenMatching(panelBox, spec.panel);
    if (labels.length === 0 || labels.length !== panels.length) continue;

    panels.forEach((panel, i) => labelPanel(panel, labelOf(labels[i]!)));
    labelBox.remove();
    for (const input of childrenMatching(group, 'input[type="radio" i]')) input.remove();
  }
}

/** Etapa 3 (antes de cleanDom remover `hidden`/`button`): reescreve grupos de abas como painéis rotulados. */
export function normalizeTabs(doc: Document): void {
  normalizeAriaTabs(doc);
  for (const spec of POSITIONAL_GROUPS) normalizePositionalTabs(doc, spec);
}
