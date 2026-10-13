/**
 * The lab screen's DOM: top bar, the 3D stage, the tool bar and tool panel, and the side column with the
 * stage checklist, the patient monitor and the mentor. `update` redraws from a `Simulation`; everything
 * shown is computed in `hudModel.ts` (tested), this file only places it. Text uses textContent only.
 */
import { CARM, CARM_PRESETS } from '../config/anatomy';
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
  stageList,
  stageView,
  timeString,
  toastView,
  toolButtons,
  usageReadout,
} from './hudModel';
import type { HoldButton } from './input';
import type { UiCommand } from './input';
import { DEMO_BADGE, DEMO_HINT, END_CASE_WARNING, LAB_DISCLAIMER, LAB_LIMITS, LAB_TITLE, LAB_TOUCH_HINT, PAUSE_TEXT } from './labContent';
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
  /** The demo's speed buttons (1, 2 or 4 times). */
  readonly onDemoSpeed: (speed: number) => void;
  /** The Take control button of the demo. */
  readonly onTakeOver: () => void;
}

export interface HudFlags {
  readonly demo: { readonly on: boolean; readonly speed: number };
  readonly view: '3d' | 'xray';
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
  const endButton = button('End case', 'secondary', 'Finish now and see the debrief (scored as incomplete)');
  helpButton.addEventListener('click', () => handlers.onUi('toggle-help'));
  pauseButton.addEventListener('click', () => handlers.onUi('pause'));
  backButton.addEventListener('click', handlers.onBack);
  endButton.addEventListener('click', handlers.onEndCase);
  const fluoroUsed = el('span', { className: 'lab-clock', text: '0:00' });
  const contrastUsed = el('span', { className: 'lab-clock', text: '0 ml' });

  // The demo's own controls. They are marked so that using them does not count as taking over.
  const demoSpeeds = [1, 2, 4].map((n) => {
    const b = button(`${n}x`, 'secondary', `Run the demo at ${n} times speed`);
    b.dataset.demoControl = 'true';
    b.addEventListener('click', () => handlers.onDemoSpeed(n));
    return { n, b };
  });
  const takeOver = button('Take control', 'primary', 'Stop the demo and carry on yourself (any key, click or wheel does the same)');
  takeOver.dataset.demoControl = 'true';
  takeOver.addEventListener('click', handlers.onTakeOver);
  const demoBar = el('div', { className: 'demo-bar hidden', attrs: { role: 'status' } }, [
    el('span', { className: 'demo-badge', text: DEMO_BADGE }),
    el('span', { className: 'demo-hint', text: DEMO_HINT }),
    ...demoSpeeds.map((x) => x.b),
    takeOver,
  ]);

  const bar = el('header', { className: 'lab-bar' }, [
    el('div', { className: 'lab-bar-title' }, [el('h1', { text: LAB_TITLE }), el('p', { className: 'lab-disclaimer', text: LAB_DISCLAIMER })]),
    el('div', { className: 'lab-bar-status' }, [
      el('span', { className: 'lab-label', text: 'Case time' }),
      clock,
      el('span', { className: 'lab-label', text: 'Fluoro' }),
      fluoroUsed,
      el('span', { className: 'lab-label', text: 'Contrast' }),
      contrastUsed,
      el('span', { className: 'lab-label', text: 'C-arm' }),
      carm,
    ]),
    el('div', { className: 'lab-bar-buttons' }, [helpButton, pauseButton, endButton, backButton]),
  ]);

  // --- the stage and its small toolbar ----------------------------------------------------------------------
  const stage = el('div', { className: 'stage' });
  const frameHeart = button('Frame heart');
  const frameRoute = button('Whole route');
  const labelsButton = button('Labels (L)');
  const followButton = button('Follow tip (F)');
  const viewButton = button('X-ray view (Tab)');
  viewButton.addEventListener('click', () => handlers.onUi('toggle-view'));
  frameHeart.addEventListener('click', handlers.onFrameHeart);
  frameRoute.addEventListener('click', handlers.onFrameRoute);
  labelsButton.addEventListener('click', () => handlers.onUi('toggle-labels'));
  followButton.addEventListener('click', () => handlers.onUi('toggle-follow'));
  const viewTools = el('div', { className: 'view-tools' }, [viewButton, frameHeart, frameRoute, labelsButton, followButton]);

  const toast = el('p', { className: 'toast hidden', attrs: { role: 'status' } });

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

  // --- the C-arm panel ----------------------------------------------------------------------------------------
  const carmSelect = el('select', { attrs: { 'aria-label': 'C-arm projection' } });
  CARM_PRESETS.forEach((p, i) => carmSelect.append(el('option', { text: p.label, attrs: { value: String(i) } })));
  carmSelect.append(el('option', { text: 'Custom', attrs: { value: 'custom', disabled: 'true' } }));
  carmSelect.addEventListener('change', () => handlers.onAction({ type: 'select-carm', index: Number(carmSelect.value) }));
  const nudge = (text: string, title: string, lao: number, cra: number): HTMLButtonElement => {
    const b = button(text, 'secondary', title);
    b.addEventListener('click', () => handlers.onAction({ type: 'adjust-carm', laoDeg: lao, cranialDeg: cra }));
    return b;
  };
  const step = CARM.coarseStepDeg;
  const carmReadoutText = el('span', { className: 'carm-readout' });
  const carmPanel = el('div', { className: 'carm-panel' }, [
    el('span', { className: 'lab-label', text: 'C-arm' }),
    carmSelect,
    nudge('◀ RAO', `Swing the detector ${step}° toward the patient's right (arrow keys: 1°, Shift 5°)`, -step, 0),
    nudge('LAO ▶', `Swing the detector ${step}° toward the patient's left`, step, 0),
    nudge('▲ CRA', `Tilt the beam ${step}° toward the head`, 0, step),
    nudge('▼ CAU', `Tilt the beam ${step}° toward the feet`, 0, -step),
    carmReadoutText,
  ]);

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
  const stageRows = el('ol', { className: 'stage-list', attrs: { 'aria-label': 'All six steps' } });
  const stagePanel = el('section', { className: 'panel stage-panel' }, [stageTitle, progress, stageGoal, taskList, hint, why, stageRows]);

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
    demoBar,
    el('div', { className: 'lab-main' }, [el('section', { className: 'lab-view' }, [el('div', { className: 'stage-wrap' }, [stage, viewTools]), toast, toolBar, carmPanel, toolPanel]), side]),
    overlays,
  ]);

  // --- per-frame update ----------------------------------------------------------------------------------------------
  let stageSignature = '';
  let mentorSignature = '';
  let rowSignature = '';
  let doneCount = 0;

  return {
    root,
    stage,
    overlays,
    update(sim: Simulation, flags: HudFlags, dt: number): void {
      setText(clock, timeString(sim.time));
      setText(carm, carmReadout(sim));
      const usage = usageReadout(sim);
      setText(fluoroUsed, usage.fluoro);
      setText(contrastUsed, usage.contrast);
      setClass(demoBar, 'hidden', !flags.demo.on);
      for (const x of demoSpeeds) setClass(x.b, 'on', flags.demo.speed === x.n);
      const note = toastView(sim);
      setClass(toast, 'hidden', note === null);
      if (note) {
        setText(toast, note.text);
        toast.className = `toast ${note.level}`;
      }
      const rows = stageList(sim);
      const rowKey = rows.map((r) => `${r.done ? r.time : r.current ? 'c' : '-'}`).join('|');
      if (rowKey !== rowSignature) {
        rowSignature = rowKey;
        const finished = rows.filter((r) => r.done).length;
        const justFinished = finished > doneCount;
        doneCount = finished;
        stageRows.replaceChildren(
          ...rows.map((r, i) =>
            el('li', { className: `${r.done ? 'done' : r.current ? 'current' : ''}${justFinished && r.done && i === finished - 1 ? ' flash' : ''}` }, [
              el('span', { className: 'row-mark', text: r.done ? '✓' : r.current ? '▶' : '○' }),
              el('span', { className: 'row-title', text: `${r.number}. ${r.title}` }),
              el('span', { className: 'row-time', text: r.time }),
            ]),
          ),
        );
      }
      setText(carmReadoutText, `LAO ${Math.round(sim.carmAngles.laoDeg)}°  CRA ${Math.round(sim.carmAngles.cranialDeg)}°`);
      const presetIndex = CARM_PRESETS.findIndex((p) => p.laoDeg === sim.carmAngles.laoDeg && p.cranialDeg === sim.carmAngles.cranialDeg);
      const wanted = presetIndex >= 0 ? String(presetIndex) : 'custom';
      if (carmSelect.value !== wanted) carmSelect.value = wanted;

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
      setClass(viewButton, 'on', flags.view === 'xray');
      viewButton.setAttribute('aria-pressed', String(flags.view === 'xray'));
      setClass(followButton, 'on', flags.follow);
      followButton.setAttribute('aria-pressed', String(flags.follow));
      setClass(help, 'hidden', !flags.help);
      setClass(pause, 'hidden', !flags.paused);
    },
  };
}
