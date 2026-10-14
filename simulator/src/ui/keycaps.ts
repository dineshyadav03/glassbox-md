/**
 * Turns a key description like "W / S or wheel" or "E (hold) / Q" into pieces, so it can be drawn as key caps with
 * the joining words between them. Pure, so the splitting is tested.
 */
import { el } from './dom';

export type KeyPart =
  | { readonly kind: 'key'; readonly text: string; readonly note?: string }
  | { readonly kind: 'sep'; readonly text: string };

const SEPARATOR = /(\s+\/\s+|\s+or\s+|\s+to\s+)/;

export function splitKeys(label: string): KeyPart[] {
  const parts: KeyPart[] = [];
  for (const piece of label.split(SEPARATOR)) {
    if (piece === '') continue;
    if (SEPARATOR.test(piece)) {
      parts.push({ kind: 'sep', text: piece.trim() });
      continue;
    }
    const match = /^(.*?)\s*(\([^)]*\))?$/.exec(piece.trim());
    const text = (match?.[1] ?? piece).trim();
    const note = match?.[2];
    parts.push(note ? { kind: 'key', text, note } : { kind: 'key', text });
  }
  return parts;
}

/** The DOM for a key description: key caps, small joining words and any note such as "(hold)". */
export function keycaps(label: string): HTMLElement {
  const wrap = el('span', { className: 'keys' });
  for (const part of splitKeys(label)) {
    if (part.kind === 'sep') {
      wrap.append(el('span', { className: 'key-sep', text: part.text }));
    } else {
      wrap.append(el('kbd', { text: part.text }));
      if (part.note) wrap.append(el('span', { className: 'key-note', text: part.note }));
    }
  }
  return wrap;
}
