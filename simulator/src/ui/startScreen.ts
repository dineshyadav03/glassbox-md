import { el } from './dom';
import { createHero } from './hero';
import { keycaps } from './keycaps';
import { BUILD_STATUS, CASE_VIGNETTE, CONTROLS, DISCLAIMER, EYEBROW, HEADLINE, SUBTITLE, TAGLINE, YOU_WILL } from './startContent';
import './theme.css';
import './start.css';

/**
 * Render the start screen into `root`. Text is set with textContent only, never innerHTML.
 * `onEnter` opens the lab; `onDemo` opens it with the autopilot performing the case.
 */
export function renderStartScreen(root: HTMLElement, onEnter: () => void, onDemo: () => void): void {
  const enter = el('button', { className: 'primary', text: 'Enter the cath lab' });
  enter.addEventListener('click', onEnter);
  const demo = el('button', { text: 'Watch a demo first' });
  demo.title = 'An autopilot performs the whole case, narrating each step. Press any key to take over.';
  demo.addEventListener('click', onDemo);

  // The disclaimer is part of the product: it sits right under the buttons, in full.
  const notice = el('p', { className: 'notice', attrs: { role: 'note' } }, [el('strong', { text: 'Educational only' }), el('span', { text: DISCLAIMER })]);

  const controls = el(
    'dl',
    { className: 'controls' },
    CONTROLS.flatMap(([keys, action]) => [el('dt', {}, [keycaps(keys)]), el('dd', { text: action })]),
  );
  const controlsBox = el('details', { className: 'controls-box', attrs: { open: '' } }, [el('summary', { text: 'Controls' }), controls]);

  root.replaceChildren(
    el('main', { className: 'start' }, [
      el('section', { className: 'start-intro' }, [
        el('p', { className: 'eyebrow', text: EYEBROW }),
        el('h1', {}, [HEADLINE, el('span', { text: SUBTITLE })]),
        el('p', { className: 'tagline', text: TAGLINE }),
        el('div', { className: 'cta' }, [enter, demo]),
        notice,
      ]),
      el('section', { className: 'start-art' }, [createHero()]),
      el('div', { className: 'start-body' }, [
        el('section', { className: 'start-section' }, [el('h2', { text: 'The case' }), el('p', { className: 'case-card', text: CASE_VIGNETTE })]),
        el('section', { className: 'start-section' }, [el('h2', { text: 'Your six steps' }), el('ol', { className: 'steps' }, YOU_WILL.map((step) => el('li', { text: step })))]),
        el('section', { className: 'start-section' }, [controlsBox]),
        el('p', { className: 'start-foot', text: BUILD_STATUS }),
      ]),
    ]),
  );
}
