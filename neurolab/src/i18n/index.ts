/**
 * Language support: every sentence the learner reads is looked up here by key, in English or Japanese. The English
 * table is the source of truth; the Japanese table must have exactly the same keys (the compiler and a test check it)
 * and the same {placeholders}. Translations can only be checked for completeness here, not for quality: a native
 * reader should review the Japanese before it is relied on.
 */
import { EN, type MessageKey } from './en';
import { JA } from './ja';

export type Lang = 'en' | 'ja';
export type { MessageKey };

let current: Lang = 'en';

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
}

export type Params = Readonly<Record<string, string | number>>;

/** The sentence for a key in the current language, with {name} placeholders filled from `params`. */
export function t(key: MessageKey, params?: Params): string {
  const table: Readonly<Record<string, string>> = current === 'ja' ? JA : EN;
  const text = table[key] ?? EN[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

const STORAGE_KEY = 'neurolab-language';

/** The language saved from last time, or the browser's, or English. Never throws (storage can be blocked). */
export function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ja') return saved;
  } catch {
    // storage blocked: fall through
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ja')) return 'ja';
  } catch {
    // no navigator
  }
  return 'en';
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage blocked: the choice just lasts this visit
  }
}

/** The placeholder names in a sentence, sorted (used to check a translation keeps them). */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}
