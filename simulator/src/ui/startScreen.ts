import { BUILD_STATUS, CASE_VIGNETTE, CONTROLS, DISCLAIMER, TITLE, YOU_WILL } from './startContent';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const child of children) node.append(child);
  return node;
}

/**
 * Render the start screen into `root`. Text is set with textContent only, never innerHTML.
 * `onEnter` opens the 3D anatomy preview (the only part of the lab that exists so far).
 */
export function renderStartScreen(root: HTMLElement, onEnter: () => void): void {
  const disclaimer = el('p', { className: 'disclaimer', text: DISCLAIMER });
  disclaimer.setAttribute('role', 'note');

  const enter = el('button', { text: 'Enter the cath lab (anatomy preview)' });
  enter.title = 'Opens the 3D anatomy. The procedure itself is not built yet.';
  enter.addEventListener('click', onEnter);
  const demo = el('button', { className: 'secondary', text: 'Watch a demo first' });
  demo.disabled = true;
  demo.title = 'Not built yet';

  const controls = el(
    'dl',
    { className: 'controls' },
    CONTROLS.flatMap(([keys, action]) => [el('dt', { text: keys }), el('dd', { text: action })]),
  );

  root.replaceChildren(
    el('main', { className: 'start' }, [
      el('h1', { text: TITLE }),
      disclaimer,
      el('h2', { text: 'The case' }),
      el('p', { text: CASE_VIGNETTE }),
      el('h2', { text: 'You will' }),
      el('ol', {}, YOU_WILL.map((step) => el('li', { text: step }))),
      el('h2', { text: 'Controls' }),
      controls,
      el('p', { className: 'status', text: BUILD_STATUS }),
      el('div', { className: 'actions' }, [enter, demo]),
    ]),
  );
}
