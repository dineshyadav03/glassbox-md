/**
 * The lab screen's DOM: top bar, the 3D stage, the tool bar and tool panel, and the side column with the
 * stage checklist, the patient monitor and the mentor. `update` redraws from a `Simulation`; everything
 * shown is computed in `hudModel.ts` (tested), this file only places it. Text uses textContent only.
 */
import { createSimulation, type Action, type Simulation } from '../engine/simulation';
import { CONTROLS } from './startContent';
import { el, setClass, setText } from './dom';
import { createDial, createPressureGauge } from './gauges';
import {
  canChooseSize,
  carmReadout,
  coverageReadout,
  dialView,
  gaugeView,
  monitorView,
  positionReadout,
  pressureAdvice,
  qcaReadout,
  sizeOptions,
  stageView,
  timeString,
  toolButtons,
} from './hudModel';
import type { HoldButton } from './input';
import type { UiCommand } from './input';
import { END_CASE_WARNING, LAB_DISCLAIMER, LAB_LIMITS, LAB_TITLE, LAB_TOUCH_HINT, PAUSE_TEXT } from './labContent';
import { createMonitor } from './monitor';

export interface HudHandlers {
  readonly onAction: (action: Action) => void;
  readonly onHold: (button: HoldButton, down: boolean) => void;
  readonly onUi: (command: UiCommand) => void;
  readonly onFine: (on: boolean) => void;
  readonly onFrameHeart: () => void;
  readonly onFrameRoute: () => void;
  readonly onEndCase: () => void;
  readonly onBack: () => void;
}

export interface HudFlags {
  readonly paused: boolean;
  readonly labels: boolean;
  readonly follow: boolean;
  readonly help: boolean;
  readonly mentor: boolean;
}

export interface Hud {
  readonly root: HTMLElement;
  /** Where the 3D canvas goes. */
  readonly stage: HTMLElement;
  /** Where overlays (debrief) go. */
  readonly overlays: HTMLElement;
  update(sim: Simulation, flags: HudFlags, dt: number): void;
}

function button(text: string, className = 'secondary', title?: string): HTMLButtonElement {
  return el('button', { className, text, title, attrs: { type: 'button' } });
}

/** A button that acts while the pointer is down (touch or mouse), like holding the key. */
function holdButton(text: string, hold: HoldButton, handlers: HudHandlers, title?: string): HTMLButtonElement {
  const b = button(text, 'hold', title);
  const press = (event: Event): void => {
    event.preventDefault();
    handlers.onHold(hold, true);
  };
  const release = (): void => handlers.onHold(hold, false);
  b.addEventListener('pointerdown', press);
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(type, release);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  return b;
}

export function createHud(handlers: HudHandlers): Hud {
  // --- top bar ---------------------------------------------------------------------------------------------
  const clock = el('span', { className: 'lab-clock', text: '0:00' });
  const carm = el('span', { className: 'lab-carm', text: '' });
  const helpButton = button('Help (H)');
  const pauseButton = button('Pause (Esc)');
  const backButton = button('Leave');
  helpButton.addEventListener('click', () => handlers.onUi('toggle-help'));
  pauseButton.addEventListener('click', () => handlers.onUi('pause'));
  backButton.addEventListener('click', handlers.onBack);
  const bar = el('header', { className: 'lab-bar' }, [
    el('div', { className: 'lab-bar-title' }, [el('h1', { text: LAB_TITLE }), el('p', { className: 'lab-disclaimer', text: LAB_DISCLAIMER })]),
    el('div', { className: 'lab-bar-status' }, [el('span', { className: 'lab-label', text: 'Case time' }), clock, el('span', { className: 'lab-label', text: 'C-arm' }), carm]),
    el('div', { className: 'lab-bar-buttons' }, [helpButton, pauseButton, backButton]),
  ]);

  // --- the stage and its small toolbar ----------------------------------------------------------------------
  const stage = el('div', { className: 'stage' });
  const frameHeart = button('Frame heart');
  const frameRoute = button('Whole route');
  const labelsButton = button('Labels (L)');
  const followButton = button('Follow tip (F)');
  frameHeart.addEventListener('click', handlers.onFrameHeart);
  frameRoute.addEventListener('click', handlers.onFrameRoute);
  labelsButton.addEventListener('click', () => handlers.onUi('toggle-labels'));
  followButton.addEventListener('click', () => handlers.onUi('toggle-follow'));
  const viewTools = el('div', { className: 'view-tools' }, [frameHeart, frameRoute, labelsButton, followButton]);

  // --- the tool bar ---------------------------------------------------------------------------------------------
  const toolNodes = new Map<string, HTMLButtonElement>();
  const toolBar = el('div', { className: 'tool-bar', attrs: { role: 'toolbar', 'aria-label': 'Tools' } });
  for (const t of toolButtons(createSimulation())) {
    const b = button(`${t.key} ${t.label}`, 'tool');
    toolNodes.set(t.id, b);
    if (t.id === 'contrast') b.addEventListener('click', () => handlers.onAction({ type: 'inject' }));
    else if (t.id === 'measure') b.addEventListener('click', () => handlers.onAction({ type: 'measure' }));
    else if (t.id === 'fluoro') {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handlers.onHold('fluoro', true);
      });
      for (const type of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(type, () => handlers.onHold('fluoro', false));
    } else b.addEventListener('click', () => handlers.onAction({ type: 'select-tool', tool: t.id as 'guide' | 'wire' | 'balloon' | 'stent' }));
    toolBar.append(b);
  }
  const heparinButton = button('G Heparin', 'tool');
  heparinButton.addEventListener('click', () => handlers.onAction({ type: 'heparin' }));
  const carmButton = button('V C-arm', 'tool');
  carmButton.addEventListener('click', () => handlers.onAction({ type: 'cycle-carm', direction: 1 }));
  toolBar.append(heparinButton, carmButton);

  // --- the tool panel ---------------------------------------------------------------------------------------------
  const dial = createDial();
  const gauge = createPressureGauge();
  const position = el('p', { className: 'position-readout' });
  const advice = el('p', { className: 'advice' });
  const coverage = el('p', { className: 'coverage' });
  const qca = el('p', { className: 'qca' });
  const resistance = el('div', { className: 'resistance' }, [el('span', { text: 'Resistance' }), el('div', { className: 'resistance-bar' }, [el('div', { className: 'resistance-fill' })])]);
  const resistanceFill = resistance.querySelector('.resistance-fill') as HTMLElement;

  const fine = el('input', { attrs: { type: 'checkbox', id: 'fine-toggle' } });
  fine.addEventListener('change', () => handlers.onFine(fine.checked));
  const fineLabel = el('label', { className: 'fine', attrs: { for: 'fine-toggle' } }, [fine, ' Fine control (Shift)']);

  const retract = holdButton('◀ Retract (S)', 'retract', handlers);
  const advance = holdButton('Advance (W) ▶', 'advance', handlers);
  const rotateLeft = holdButton('⟲ Turn (A)', 'rotate-left', handlers);
  const rotateRight = holdButton('Turn (D) ⟳', 'rotate-right', handlers);
  const inflate = holdButton('Inflate (E)', 'inflate', handlers);
  const deflate = holdButton('Deflate (Q)', 'deflate', handlers);

  const makeSelect = (values: readonly number[], suffix: string): HTMLSelectElement => {
    const s = el('select');
    for (const v of values) s.append(el('option', { text: `${v}${suffix}`, attrs: { value: String(v) } }));
    return s;
  };
  const balloonSizes = sizeOptions('balloon');
  const stentSizes = sizeOptions('stent');
  const sizeRows = {
    balloon: { diameter: makeSelect(balloonSizes.diameters, ' mm'), length: makeSelect(balloonSizes.lengths, ' mm') },
    stent: { diameter: makeSelect(stentSizes.diameters, ' mm'), length: makeSelect(stentSizes.lengths, ' mm') },
  };
  const sizePanel = el('div', { className: 'size-panel' });
  for (const kind of ['balloon', 'stent'] as const) {
    const row = sizeRows[kind];
    const send = (): void =>
      handlers.onAction({ type: 'choose-size', kind, diameter: Number(row.diameter.value), length: Number(row.length.value) });
    row.diameter.addEventListener('change', send);
    row.length.addEventListener('change', send);
    sizePanel.append(el('label', { className: `size-row size-${kind}` }, [el('span', { text: kind === 'balloon' ? 'Balloon size' : 'Stent size' }), row.diameter, ' x ', row.length]));
  }

  const dialBox = el('div', { className: 'dial-box' }, [dial.title, dial.root]);
  const moveRow = el('div', { className: 'hold-row' }, [retract, advance, rotateLeft, rotateRight, fineLabel]);
  const inflateRow = el('div', { className: 'hold-row inflate-row' }, [inflate, deflate]);
  const toolPanel = el('section', { className: 'panel tool-panel' }, [
    el('div', { className: 'tool-panel-main' }, [dialBox, el('div', { className: 'tool-panel-text' }, [position, advice, resistance, coverage, qca])]),
    sizePanel,
    gauge.root,
    moveRow,
    inflateRow,
  ]);

  // --- the side column --------------------------------------------------------------------------------------------
  const stageTitle = el('h2', { className: 'stage-title' });
  const stageGoal = el('p', { className: 'stage-goal' });
  const taskList = el('ul', { className: 'tasks' });
  const progressFill = el('div', { className: 'progress-fill' });
  const progress = el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': 'Case progress', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, [progressFill]);
  const hint = el('p', { className: 'hint' });
  const whyText = el('p', { className: 'why' });
  const why = el('details', { className: 'why-box' }, [el('summary', { text: 'Why this step?' }), whyText]);
  const stagePanel = el('section', { className: 'panel stage-panel' }, [stageTitle, progress, stageGoal, taskList, hint, why]);

  const monitor = createMonitor();

  const mentorLog = el('ol', { className: 'mentor-log', attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Mentor' } });
  const mentorPanel = el('section', { className: 'panel mentor' }, [el('h2', { text: 'Mentor (M)' }), mentorLog]);

  const side = el('aside', { className: 'lab-side' }, [stagePanel, monitor.root, mentorPanel]);

  // --- overlays ----------------------------------------------------------------------------------------------------
  const helpBody = el('dl', { className: 'controls' }, CONTROLS.flatMap(([keys, action]) => [el('dt', { text: keys }), el('dd', { text: action })]));
  const helpClose = button('Close', 'secondary');
  helpClose.addEventListener('click', () => handlers.onUi('toggle-help'));
  const help = el('div', { className: 'overlay help hidden', attrs: { role: 'dialog', 'aria-label': 'Help' } }, [
    el('div', { className: 'overlay-panel' }, [el('h2', { text: 'Controls' }), helpBody, el('p', { className: 'status', text: LAB_LIMITS }), el('p', { className: 'status', text: LAB_TOUCH_HINT }), helpClose]),
  ]);

  const resume = button('Resume (Esc)', 'primary');
  const endCase = button('End the case', 'secondary');
  resume.addEventListener('click', () => handlers.onUi('pause'));
  endCase.addEventListener('click', handlers.onEndCase);
  const pause = el('div', { className: 'overlay pause hidden', attrs: { role: 'dialog', 'aria-label': 'Paused' } }, [
    el('div', { className: 'overlay-panel' }, [el('h2', { text: PAUSE_TEXT }), el('p', { className: 'status', text: END_CASE_WARNING }), el('div', { className: 'actions' }, [resume, endCase])]),
  ]);
  const overlays = el('div', { className: 'overlays' }, [help, pause]);

  const root = el('main', { className: 'lab' }, [
    bar,
    el('div', { className: 'lab-main' }, [el('section', { className: 'lab-view' }, [el('div', { className: 'stage-wrap' }, [stage, viewTools]), toolBar, toolPanel]), side]),
    overlays,
  ]);

  // --- per-frame update ----------------------------------------------------------------------------------------------
  let stageSignature = '';
  let mentorSignature = '';

  return {
    root,
    stage,
    overlays,
    update(sim: Simulation, flags: HudFlags, dt: number): void {
      setText(clock, timeString(sim.time));
      setText(carm, carmReadout(sim));

      // Tools.
      for (const t of toolButtons(sim)) {
        const node = toolNodes.get(t.id)!;
        setClass(node, 'active', t.active);
        setClass(node, 'locked', !t.available);
        node.setAttribute('aria-disabled', String(!t.available));
        node.setAttribute('aria-pressed', String(t.active));
        node.title = t.available ? '' : (t.reason ?? '');
      }
      setClass(heparinButton, 'done', sim.patient.heparinGiven);

      // Stage panel.
      const stage = stageView(sim);
      const signature = `${stage.number}|${stage.tasks.map((t) => (t.done ? 1 : t.next ? 'n' : 0)).join('')}`;
      if (signature !== stageSignature) {
        stageSignature = signature;
        setText(stageTitle, stage.finished ? stage.title : `Step ${stage.number} of ${stage.total}: ${stage.title}`);
        setText(stageGoal, stage.goal);
        setText(whyText, stage.why);
        taskList.replaceChildren(
          ...stage.tasks.map((t) => el('li', { className: t.done ? 'done' : t.next ? 'next' : '', text: `${t.done ? '✓' : t.next ? '▶' : '○'} ${t.label}` })),
        );
      }
      progressFill.style.width = `${Math.round(stage.overall * 100)}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(stage.overall * 100)));
      setText(hint, stage.hint);

      // Monitor.
      monitor.update(monitorView(sim), flags.paused ? 0 : dt);

      // Tool panel.
      const tool = sim.tool;
      const isCatheter = tool === 'balloon' || tool === 'stent';
      const view = dialView(sim);
      dial.update(view);
      dialBox.style.display = view ? '' : 'none';
      setText(position, positionReadout(sim));
      setText(advice, pressureAdvice(sim));
      resistance.style.display = tool === 'wire' ? '' : 'none';
      resistanceFill.style.width = `${Math.round(sim.wire.resistance * 100)}%`;
      setClass(resistance, 'buckled', sim.wire.buckled);
      setText(coverage, tool === 'stent' ? (coverageReadout(sim) ?? '') : '');
      setText(qca, qcaReadout(sim) ?? '');
      gauge.root.style.display = isCatheter ? '' : 'none';
      sizePanel.style.display = isCatheter ? '' : 'none';
      inflateRow.style.display = isCatheter ? '' : 'none';
      rotateLeft.style.display = isCatheter ? 'none' : '';
      rotateRight.style.display = isCatheter ? 'none' : '';
      if (isCatheter) {
        const c = tool === 'balloon' ? sim.balloon : sim.stent;
        gauge.update(gaugeView(c));
        for (const kind of ['balloon', 'stent'] as const) {
          const row = sizeRows[kind];
          const cc = kind === 'balloon' ? sim.balloon : sim.stent;
          (row.diameter.closest('label') as HTMLElement).style.display = kind === tool ? '' : 'none';
          const enabled = canChooseSize(cc);
          row.diameter.disabled = !enabled;
          row.length.disabled = !enabled;
          if (row.diameter.value !== String(cc.spec.diameter)) row.diameter.value = String(cc.spec.diameter);
          if (row.length.value !== String(cc.spec.length)) row.length.value = String(cc.spec.length);
        }
      }

      // Mentor.
      const last = sim.messages[sim.messages.length - 1];
      const mSignature = `${sim.messages.length}|${last?.t ?? 0}|${last?.text ?? ''}`;
      if (mSignature !== mentorSignature) {
        mentorSignature = mSignature;
        const recent = sim.messages.slice(-8);
        mentorLog.replaceChildren(...recent.map((m) => el('li', { className: m.level, text: `${timeString(m.t)}  ${m.text}` })));
        mentorLog.scrollTop = mentorLog.scrollHeight;
      }
      setClass(mentorPanel, 'collapsed', !flags.mentor);

      // Toggles and overlays.
      setClass(labelsButton, 'on', flags.labels);
      labelsButton.setAttribute('aria-pressed', String(flags.labels));
      setClass(followButton, 'on', flags.follow);
      followButton.setAttribute('aria-pressed', String(flags.follow));
      setClass(help, 'hidden', !flags.help);
      setClass(pause, 'hidden', !flags.paused);
    },
  };
}
