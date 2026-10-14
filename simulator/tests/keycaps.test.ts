import { describe, expect, it } from 'vitest';
import { splitKeys } from '../src/ui/keycaps';
import { CONTROLS } from '../src/ui/startContent';

describe('splitKeys', () => {
  it('splits keys joined by a slash, and keeps the joining word', () => {
    expect(splitKeys('W / S or wheel')).toEqual([
      { kind: 'key', text: 'W' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: 'S' },
      { kind: 'sep', text: 'or' },
      { kind: 'key', text: 'wheel' },
    ]);
  });

  it('keeps a note such as (hold) with its key, not as a key of its own', () => {
    expect(splitKeys('E (hold) / Q')).toEqual([
      { kind: 'key', text: 'E', note: '(hold)' },
      { kind: 'sep', text: '/' },
      { kind: 'key', text: 'Q' },
    ]);
    expect(splitKeys('Space or 6 (hold)')).toEqual([
      { kind: 'key', text: 'Space' },
      { kind: 'sep', text: 'or' },
      { kind: 'key', text: '6', note: '(hold)' },
    ]);
  });

  it('treats a range as two keys joined by "to", and a single key as one', () => {
    expect(splitKeys('1 to 7')).toEqual([{ kind: 'key', text: '1' }, { kind: 'sep', text: 'to' }, { kind: 'key', text: '7' }]);
    expect(splitKeys('Tab')).toEqual([{ kind: 'key', text: 'Tab' }]);
    expect(splitKeys('Drag / Ctrl + wheel')).toEqual([{ kind: 'key', text: 'Drag' }, { kind: 'sep', text: '/' }, { kind: 'key', text: 'Ctrl + wheel' }]);
  });

  it('never loses text: every control description splits into pieces that rejoin to the same words', () => {
    for (const [keys] of CONTROLS) {
      const parts = splitKeys(keys);
      expect(parts.length).toBeGreaterThan(0);
      const words = parts.flatMap((p) => (p.kind === 'key' ? [p.text, p.note ?? ''] : [p.text])).join(' ').replace(/\s+/g, ' ').trim();
      const original = keys.replace(/\s+/g, ' ').trim();
      for (const token of original.split(' ')) expect(words).toContain(token.replace(/[()]/g, ''));
    }
  });

  it('copes with an empty description', () => {
    expect(splitKeys('')).toEqual([]);
  });
});
