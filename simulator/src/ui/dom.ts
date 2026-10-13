/** Tiny DOM helpers. Text is always set with textContent, never innerHTML. */

export interface ElOptions {
  readonly className?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) node.append(child);
  return node;
}

/** Set an element's text only if it changed, so per-frame updates do not churn the DOM. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: HTMLElement, name: string, on: boolean): void {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {},
  children: Node[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) node.append(child);
  return node;
}
