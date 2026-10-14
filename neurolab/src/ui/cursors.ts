/** One small cursor and toolbar icon per tool, drawn as inline SVG so there are no image files. */
import type { ToolId } from '../tools/tools';

const DARK = '#10060c';
const STEEL = '#dfe4ea';

const outlined = (shape: string, fill: string, width = 1.6): string =>
  `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${shape}" stroke="${DARK}" stroke-width="${width + 2.6}"/><path d="${shape}" stroke="${fill}" stroke-width="${width}"/></g>`;

const ICONS: Readonly<Record<ToolId, string>> = {
  suction: outlined('M4 21 L14 11', STEEL, 2.6) + `<circle cx="16" cy="9" r="3.2" fill="#e9a5b0" stroke="${DARK}" stroke-width="1.2"/>`,
  scissors:
    outlined('M5 5 L19 19', STEEL) +
    outlined('M19 5 L5 19', STEEL) +
    `<circle cx="5.5" cy="5.5" r="2" fill="none" stroke="#ffd54a" stroke-width="1.4"/><circle cx="18.5" cy="5.5" r="2" fill="none" stroke="#ffd54a" stroke-width="1.4"/>`,
  bipolar: outlined('M5 20 L11 12 L11 4', STEEL, 1.8) + outlined('M9 20 L13 12 L15 4', STEEL, 1.8) + `<circle cx="11" cy="3.5" r="1.4" fill="#ffd54a"/><circle cx="15" cy="3.5" r="1.4" fill="#ffd54a"/>`,
  dissector: outlined('M4 21 L16 9', STEEL, 2.2) + `<ellipse cx="17.5" cy="7.5" rx="3" ry="1.7" transform="rotate(-45 17.5 7.5)" fill="#cfd6de" stroke="${DARK}" stroke-width="1.2"/>`,
  spatula: `<rect x="3" y="9" width="17" height="6" rx="1.2" fill="#aab4c0" stroke="${DARK}" stroke-width="1.6"/><path d="M6 12h11" stroke="#6c7683" stroke-width="1"/>`,
  clip:
    outlined('M6 4 L6 14 Q6 20 12 20 Q18 20 18 14 L18 4', '#d8b04a', 2.2) + `<path d="M6 4h4M14 4h4" stroke="#d8b04a" stroke-width="2.2" stroke-linecap="round"/>`,
  icg:
    `<circle cx="12" cy="12" r="4" fill="#58ff9a" stroke="${DARK}" stroke-width="1.4"/>` +
    outlined('M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.8 2.8M16.2 16.2L19 19M19 5l-2.8 2.8M7.8 16.2L5 19', '#58ff9a', 1.6),
  doppler: outlined('M4 21 L13 12', STEEL, 2.4) + outlined('M15 7 Q19 7 19 11', '#7fd6ff', 1.6) + outlined('M16 3 Q23 3 23 10', '#7fd6ff', 1.6),
  endoscope: `<circle cx="14" cy="10" r="6.5" fill="#0c1d28" stroke="${DARK}" stroke-width="1.6"/><circle cx="14" cy="10" r="4.2" fill="#2b6f8c"/>` + outlined('M9 15 L3 21', STEEL, 2.4),
  tempClip: outlined('M5 8 H19', '#d8b04a', 2.4) + outlined('M5 16 H19', '#d8b04a', 2.4) + outlined('M7 8 V16 M17 8 V16', '#d8b04a', 1.6),
};

/** The SVG of a tool's icon. */
export function iconSvg(tool: ToolId, size = 24): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${ICONS[tool]}</svg>`;
}

/** The CSS `cursor` value for a tool: its icon centred on the pointer, with a crosshair as the fallback. */
export function cursorFor(tool: ToolId): string {
  return `url("data:image/svg+xml,${encodeURIComponent(iconSvg(tool))}") 12 12, crosshair`;
}

/** A tool's icon as an SVG element (built by the parser from the constants above, never from user text). */
export function iconElement(tool: ToolId): SVGElement {
  const doc = new DOMParser().parseFromString(iconSvg(tool, 22).replace('<svg ', '<svg aria-hidden="true" '), 'image/svg+xml');
  return document.importNode(doc.documentElement, true) as unknown as SVGElement;
}
