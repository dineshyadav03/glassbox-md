import type { Debrief } from '../procedure/evaluation';
import type { Simulation } from '../engine/simulation';
import { el } from './dom';
import { timeString } from './hudModel';
import { GRADE_CLASS, STATUS_WORD } from './labContent';

export interface DebriefHandlers {
  readonly onRestart: () => void;
  readonly onBack: () => void;
}

/** The scored debrief, as an overlay. Text only, never innerHTML. */
export function createDebrief(debrief: Debrief, sim: Simulation, handlers: DebriefHandlers): HTMLElement {
  const restart = el('button', { text: 'Run the case again' });
  const back = el('button', { className: 'secondary', text: 'Back to the start screen' });
  restart.addEventListener('click', handlers.onRestart);
  back.addEventListener('click', handlers.onBack);

  const items = debrief.items.map((item) =>
    el('li', { className: `debrief-item ${item.status}` }, [
      el('div', { className: 'debrief-row' }, [
        el('span', { className: 'debrief-label', text: item.label }),
        el('span', { className: 'debrief-value', text: item.value }),
        el('span', { className: `debrief-status ${item.status}`, text: `${STATUS_WORD[item.status]} · ${item.points}/${item.maxPoints}` }),
      ]),
      el('p', { className: 'debrief-teaching', text: item.teaching }),
    ]),
  );

  const capped = debrief.cappedBy.length > 0 ? [el('p', { className: 'debrief-capped', text: `Grade held at "Needs work" by: ${debrief.cappedBy.join(', ')}.` })] : [];

  const panel = el('div', { className: 'debrief-panel', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Debrief' } }, [
    el('h2', { text: 'Debrief' }),
    el('div', { className: `debrief-grade ${GRADE_CLASS[debrief.grade] ?? ''}` }, [
      el('span', { className: 'debrief-grade-word', text: debrief.grade }),
      el('span', { className: 'debrief-score', text: `${debrief.score} / 100` }),
    ]),
    el('p', { className: 'debrief-headline', text: debrief.headline }),
    ...capped,
    el('p', { className: 'debrief-meta', text: `Case time ${timeString(sim.time)} · contrast ${Math.round(sim.contrastMl)} ml · fluoroscopy ${(sim.fluoroSeconds / 60).toFixed(1)} min` }),
    el('ul', { className: 'debrief-items' }, items),
    el('p', { className: 'debrief-note', text: 'These thresholds and weights are teaching choices in a simplified model. They are not clinical standards.' }),
    el('div', { className: 'actions' }, [restart, back]),
  ]);
  return el('div', { className: 'overlay debrief' }, [panel]);
}
