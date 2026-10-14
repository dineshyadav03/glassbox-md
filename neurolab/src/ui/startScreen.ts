import { t } from '../i18n';
import { buildStatus, disclaimer, eyebrow, headline, subtitle, tagline } from './startContent';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const STYLE = `
.start { min-height: 100vh; box-sizing: border-box; display: grid; place-content: center; gap: 14px; padding: 32px 20px;
  color: #e7e9f2; font: 16px/1.5 system-ui, 'Segoe UI', sans-serif; max-width: 760px; margin: 0 auto; }
.start .eyebrow { margin: 0; color: #8f9ad6; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
.start h1 { margin: 0; font-size: clamp(34px, 7vw, 56px); line-height: 1.05; }
.start h1 span { display: block; color: #9aa6ee; font-weight: 500; font-size: .55em; margin-top: 6px; }
.start .tagline { margin: 0; color: #b8bdd6; }
.start .notice { margin: 10px 0 0; padding: 12px 14px; border-radius: 10px; background: #1b1626; border: 1px solid #5b4a86; }
.start .notice strong { display: block; color: #e7c46a; margin-bottom: 4px; }
.start .cta { display: flex; flex-wrap: wrap; gap: 10px; }
.start button { font: inherit; cursor: pointer; padding: 10px 20px; border-radius: 10px; border: 1px solid #3a3052; background: #1b1427; color: #e7e9f2; }
.start button:hover { border-color: #6b5b9a; }
.start button.primary { font-weight: 600; border-color: #67b7a6; background: #14383a; color: #e9fffa; }
.start button.primary:hover { background: #1b4a4c; }
.start .foot { margin: 0; color: #8b90ab; font-size: 14px; }
`;

export interface StartHandlers {
  readonly onEnter: () => void;
  readonly onDemo: () => void;
}

/** Render the start screen into `root`. Text is set with textContent only, never innerHTML. */
export function renderStartScreen(root: HTMLElement, handlers: StartHandlers): void {
  const enter = el('button', t('start.enter'), 'primary');
  enter.addEventListener('click', handlers.onEnter);
  const demo = el('button', t('start.demo'));
  demo.title = t('start.demoTitle');
  demo.addEventListener('click', handlers.onDemo);

  const style = el('style');
  style.textContent = STYLE;
  const notice = el('p', undefined, 'notice');
  notice.setAttribute('role', 'note');
  notice.append(el('strong', t('start.disclaimerTitle')), el('span', disclaimer()));
  const heading = el('h1', headline());
  heading.append(el('span', subtitle()));
  const buttons = el('div', undefined, 'cta');
  buttons.append(enter, demo);
  const main = el('main', undefined, 'start');
  main.append(el('p', eyebrow(), 'eyebrow'), heading, el('p', tagline(), 'tagline'), buttons, notice, el('p', buildStatus(), 'foot'));
  root.replaceChildren(style, main);
}
