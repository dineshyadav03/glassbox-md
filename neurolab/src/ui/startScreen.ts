import { BUILD_STATUS, DISCLAIMER, EYEBROW, HEADLINE, SUBTITLE, TAGLINE } from './startContent';

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
.start button.primary { justify-self: start; font: inherit; font-weight: 600; cursor: pointer; padding: 10px 20px; border-radius: 10px; border: 1px solid #67b7a6; background: #14383a; color: #e9fffa; }
.start button.primary:hover { background: #1b4a4c; }
.start .foot { margin: 0; color: #8b90ab; font-size: 14px; }
`;

/** Render the start screen into `root`. Text is set with textContent only, never innerHTML. */
export function renderStartScreen(root: HTMLElement, onEnter: () => void): void {
  const enter = el('button', 'Enter the operating room', 'primary');
  enter.addEventListener('click', onEnter);
  const style = el('style');
  style.textContent = STYLE;
  const notice = el('p', undefined, 'notice');
  notice.setAttribute('role', 'note');
  notice.append(el('strong', 'Educational only'), el('span', DISCLAIMER));
  const heading = el('h1', HEADLINE);
  heading.append(el('span', SUBTITLE));
  const main = el('main', undefined, 'start');
  main.append(el('p', EYEBROW, 'eyebrow'), heading, el('p', TAGLINE, 'tagline'), enter, notice, el('p', BUILD_STATUS, 'foot'));
  root.replaceChildren(style, main);
}
