import { el } from './dom';
import { BUILD_STATUS, CASE_VIGNETTE, CONTROLS, DISCLAIMER, TITLE, YOU_WILL } from './startContent';

/**
 * Render the start screen into `root`. Text is set with textContent only, never innerHTML.
 * `onEnter` opens the lab.
 */
export function renderStartScreen(root: HTMLElement, onEnter: () => void): void {
  const disclaimer = el('p', { className: 'disclaimer', text: DISCLAIMER });
  disclaimer.setAttribute('role', 'note');

  const enter = el('button', { text: 'Enter the cath lab' });
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
