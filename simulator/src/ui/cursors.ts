/** One small cursor per tool, so the hand shows what is in it. Drawn as inline SVG, so there are no image files. */
import type { ToolId } from '../procedure/stages';

const ICONS: Readonly<Record<ToolId, string>> = {
  guide:
    '<path d="M5 21 C5 11 13 15 15 4" fill="none" stroke="#06231f" stroke-width="5" stroke-linecap="round"/>' +
    '<path d="M5 21 C5 11 13 15 15 4" fill="none" stroke="#3fb6a8" stroke-width="2.6" stroke-linecap="round"/>' +
    '<circle cx="15" cy="4" r="2.6" fill="#ffd54a"/>',
  wire:
    '<path d="M4 20 L18 6" stroke="#06231f" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M4 20 L18 6" stroke="#f2f6fa" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="18" cy="6" r="2.2" fill="#ffd54a"/>',
  balloon:
    '<ellipse cx="12" cy="12" rx="5.5" ry="9" fill="#7fc4ff" fill-opacity="0.55" stroke="#06231f" stroke-width="3"/>' +
    '<ellipse cx="12" cy="12" rx="5.5" ry="9" fill="none" stroke="#7fc4ff" stroke-width="1.6"/>',
  stent:
    '<rect x="4" y="7" width="16" height="10" rx="2" fill="none" stroke="#06231f" stroke-width="4"/>' +
    '<rect x="4" y="7" width="16" height="10" rx="2" fill="none" stroke="#e4eaf0" stroke-width="1.5"/>' +
    '<path d="M8 7v10M12 7v10M16 7v10M4 12h16" stroke="#e4eaf0" stroke-width="1"/>',
  contrast: '<path d="M12 3 C12 3 5 11 5 15 a7 7 0 0 0 14 0 C19 11 12 3 12 3Z" fill="#8fd8ff" stroke="#06231f" stroke-width="2"/>',
  fluoro:
    '<circle cx="12" cy="12" r="3" fill="#ffd54a" stroke="#06231f" stroke-width="1.5"/>' +
    '<path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5L19 19M19 5l-3.5 3.5M8.5 15.5L5 19" stroke="#06231f" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3.5 3.5M15.5 15.5L19 19M19 5l-3.5 3.5M8.5 15.5L5 19" stroke="#ffd54a" stroke-width="1.8" stroke-linecap="round"/>',
  measure:
    '<rect x="2" y="8" width="20" height="8" rx="1.5" fill="#ffd54a" stroke="#06231f" stroke-width="1.6"/>' +
    '<path d="M6 8v4M10 8v3M14 8v4M18 8v3" stroke="#06231f" stroke-width="1.4"/>',
};

/** The SVG of a tool's cursor icon. */
export function cursorSvg(tool: ToolId): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${ICONS[tool]}</svg>`;
}

/** The CSS `cursor` value for a tool: its icon centred on the pointer, with a pointing hand as the fallback. */
export function cursorFor(tool: ToolId): string {
  return `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(tool))}") 12 12, pointer`;
}

/** Icons for the two buttons that are not tools. */
const EXTRA_ICONS = {
  heparin:
    '<path d="M4 20 L11 13" stroke="#ccd6df" stroke-width="2" stroke-linecap="round"/>' +
    '<rect x="9" y="5" width="11" height="6" rx="1.2" transform="rotate(45 14.5 8)" fill="none" stroke="#ccd6df" stroke-width="1.6"/>' +
    '<path d="M15.5 4.5 L19.5 8.5 M17.5 2.5 L21.5 6.5" stroke="#ccd6df" stroke-width="1.8" stroke-linecap="round"/>',
  carm:
    '<path d="M5 20 A9 9 0 1 1 19 20" fill="none" stroke="#ccd6df" stroke-width="2" stroke-linecap="round"/>' +
    '<rect x="2.5" y="17" width="5" height="5" rx="1" fill="#ccd6df"/><rect x="16.5" y="17" width="5" height="5" rx="1" fill="#ccd6df"/>',
} as const;

export type IconName = ToolId | keyof typeof EXTRA_ICONS;

/** An icon as an SVG element (built by the parser from the constants above, never from user text). */
export function iconElement(name: IconName): SVGElement {
  const body = name === 'heparin' || name === 'carm' ? EXTRA_ICONS[name] : ICONS[name];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return document.importNode(doc.documentElement, true) as unknown as SVGElement;
}
