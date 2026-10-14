/**
 * Every sentence the learner reads is looked up here by key, so the wording lives in one place (`en.ts`) and the code
 * that builds the screens and the mentor's notes never holds prose. English only.
 */
import { EN, type MessageKey } from './en';

export type { MessageKey };

export type Params = Readonly<Record<string, string | number>>;

/** The sentence for a key, with {name} placeholders filled from `params` (an unknown placeholder is left as written). */
export function t(key: MessageKey, params?: Params): string {
  const text: string = EN[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
