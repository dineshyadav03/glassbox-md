/**
 * The lab screen's DOM. Layout: a top bar; then steps on the left, the stage in the middle and the monitor and mentor on
 * the right; then a dock along the bottom with the tools, the device panel and the C-arm. `update` redraws from a
 * `Simulation`; everything shown is computed in `hudModel.ts` (tested), this file only places it. Text is set with
 * textContent only.
 */
import { CARM, CARM_PRESETS } from '../config/anatomy';
import { createSimulation, type Action, type Simulation } from '../engine/simulation';
import { CONTROLS } from './startContent';
import { el, setClass, setText } from './dom';
import { cursorFor, iconElement, type IconName } from './cursors';
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
import { keycaps } from './keycaps';
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
  /** Sound is on. */
  readonly sound: boolean;
  /** Measuring: hovering an artery in the 3D view reads out its diameter. */
  readonly measure: boolean;
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
  /** Show the hover read-out near (x, y) inside the stage, or hide it with null. */
  setMeasureTip(lines: readonly string[] | null, x: number, y: number): void;
}

function button(text: string, className = '', title?: string): HTMLButtonElement {
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

/** A tool button: its icon, its name and its key. */
function toolButton(icon: IconName, name: string, key: string): HTMLButtonElement {
  const b = button('', 'tool');
  b.append(iconElement(icon), el('span', { className: 'tool-name', text: name }), el('span', { className: 'keycap', text: key }));
  return b;
}

/** A small stat in the top bar: a label over a value. */
function chip(label: string, value: HTMLElement): HTMLElement {
  return el('div', { className: 'chip' }, [el('span', { className: 'chip-label', text: label }), value]);
}

export function createHud(handlers: HudHandlers): Hud {
  // --- top bar ---------------------------------------------------------------------------------------------
  const clock = el('span', { className: 'chip-value', text: '0:00' });
  const fluoroUsed = el('span', { className: 'chip-value', text: '0:00' });
  const contrastUsed = el('span', { className: 'chip-value', text: '0 ml' });
  const carm = el('span', { className: 'chip-value', text: '' });
  const helpButton = button('Help', 'ghost', 'Controls and notes (H)');
  const pauseButton = button('Pause', 'ghost', 'Pause the case (Esc)');
  const endButton = button('End case', 'danger', 'Finish now and see the debrief (scored as incomplete)');
  const backButton = button('Leave', 'ghost', 'Back to the start screen');
  helpButton.addEventListener('click', () => handlers.onUi('toggle-help'));
  pauseButton.addEventListener('click', () => handlers.onUi('pause'));
  backButton.addEventListener('click', handlers.onBack);
  endButton.addEventListener('click', handlers.onEndCase);

  const logo = iconElement('guide');
  logo.classList.add('logo');
  const bar = el('header', { className: 'lab-bar' }, [
    el('div', { className: 'brand' }, [
      logo,
      el('div', {}, [
        el('h1', {}, [LAB_TITLE.split(':')[0] ?? LAB_TITLE, el('span', { text: ' PCI simulator' })]),
        el('p', { className: 'lab-disclaimer', text: LAB_DISCLAIMER }),
      ]),
    ]),
    el('div', { className: 'chips' }, [chip('Case time', clock), chip('Fluoro', fluoroUsed), chip('Contrast', contrastUsed), chip('C-arm', carm)]),
    el('div', { className: 'bar-buttons' }, [helpButton, pauseButton, endButton, backButton]),
  ]);

  // --- the demo's own controls (marked so using them does not count as taking over) -----------------------------
  const demoSpeeds = [1, 2, 4].map((n) => {
    const b = button(`${n}x`, '', `Run the demo at ${n} times speed`);
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
    el('span', { className: 'demo-speeds' }, demoSpeeds.map((x) => x.b)),
    takeOver,
  ]);

  // --- the stage and the buttons floating over it -----------------------------------------------------------------
  const stage = el('div', { className: 'stage' });
  const measureTip = el('div', { className: 'measure-tip hidden', attrs: { role: 'status' } });
  stage.append(measureTip);

  const view3d = el('button', { className: 'seg', attrs: { type: 'button' } }, ['3D']);
  const viewXray = el('button', { className: 'seg', attrs: { type: 'button' } }, ['X-ray ', el('span', { className: 'keycap', text: 'Tab' })]);
  let currentView: '3d' | 'xray' = '3d';
  view3d.addEventListener('click', () => {
    if (currentView !== '3d') handlers.onUi('toggle-view');
  });
  viewXray.addEventListener('click', () => {
    if (currentView !== 'xray') handlers.onUi('toggle-view');
  });
  const viewSwitch = el('div', { className: 'view-switch', attrs: { role: 'group', 'aria-label': 'View' } }, [view3d, viewXray]);

  const pill = (text: string, title: string, key?: string): HTMLButtonElement => {
    const b = button('', 'pill', title);
    b.append(text);
    if (key) b.append(' ', el('span', { className: 'keycap', text: key }));
    return b;
  };
  const labelsButton = pill('Labels', 'Show or hide the anatomy labels', 'L');
  const followButton = pill('Follow tip', 'The camera follows the tip of what you are moving', 'F');
  const soundButton = pill('Sound', 'Sound on or off', 'N');
  const frameHeart = pill('Frame heart', 'Look at the whole heart');
  const frameRoute = pill('Whole route', 'Look at the whole route from the wrist');
  frameHeart.classList.add('optional');
  frameRoute.classList.add('optional');
  labelsButton.addEventListener('click', () => handlers.onUi('toggle-labels'));
  followButton.addEventListener('click', () => handlers.onUi('toggle-follow'));
  soundButton.addEventListener('click', () => handlers.onUi('toggle-sound'));
  frameHeart.addEventListener('click', handlers.onFrameHeart);
  frameRoute.addEventListener('click', handlers.onFrameRoute);
  const viewTools = el('div', { className: 'view-tools' }, [frameHeart, frameRoute, labelsButton, followButton, soundButton]);

  const toast = el('p', { className: 'toast hidden', attrs: { role: 'status' } });

  // --- the tools -------------------------------------------------------------------------------------------------------
  const toolNodes = new Map<string, HTMLButtonElement>();
  const groups: Record<string, HTMLElement> = {
    devices: el('div', { className: 'tool-col' }, [el('span', { className: 'group-label', text: 'Devices' })]),
    imaging: el('div', { className: 'tool-col' }, [el('span', { className: 'group-label', text: 'Imaging' })]),
    actions: el('div', { className: 'tool-col' }, [el('span', { className: 'group-label', text: 'Actions' })]),
  };
  const groupOf = (id: string): HTMLElement => (id === 'contrast' || id === 'fluoro' || id === 'measure' ? groups.imaging! : groups.devices!);
  for (const t of toolButtons(createSimulation())) {
    const b = toolButton(t.id, t.label, t.key);
    b.dataset.tool = t.id;
    b.style.cursor = cursorFor(t.id);
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
    groupOf(t.id).append(b);
  }
  const heparinButton = toolButton('heparin', 'Heparin', 'G');
  heparinButton.title = 'Give heparin (G)';
  heparinButton.addEventListener('click', () => handlers.onAction({ type: 'heparin' }));
  const carmButton = toolButton('carm', 'Next view', 'V');
  carmButton.title = 'Cycle to the next C-arm preset (V)';
  carmButton.addEventListener('click', () => handlers.onAction({ type: 'cycle-carm', direction: 1 }));
  groups.actions!.append(heparinButton, carmButton);
  const dockTools = el('section', { className: 'dock-tools', attrs: { role: 'toolbar', 'aria-label': 'Tools' } }, [groups.devices!, groups.imaging!, groups.actions!]);

  // --- the C-arm panel --------------------------------------------------------------------------------------------------
  const carmSelect = el('select', { attrs: { 'aria-label': 'C-arm projection' } });
  CARM_PRESETS.forEach((p, i) => carmSelect.append(el('option', { text: p.label, attrs: { value: String(i) } })));
  carmSelect.append(el('option', { text: 'Custom', attrs: { value: 'custom', disabled: 'true' } }));
  carmSelect.addEventListener('change', () => handlers.onAction({ type: 'select-carm', index: Number(carmSelect.value) }));
  const nudge = (text: string, title: string, lao: number, cra: number): HTMLButtonElement => {
    const b = button(text, '', title);
    b.addEventListener('click', () => handlers.onAction({ type: 'adjust-carm', laoDeg: lao, cranialDeg: cra }));
    return b;
  };
  const step = CARM.coarseStepDeg;
  const carmReadoutText = el('span', { className: 'carm-readout' });
  const carmPanel = el('section', { className: 'panel carm-panel' }, [
    el('h2', { className: 'panel-title', text: 'C-arm' }),
    carmSelect,
    el('div', { className: 'nudge-grid' }, [
      nudge('◀ RAO', `Swing the detector ${step}° toward the patient's right (arrow keys: 1°, Shift 5°)`, -step, 0),
      nudge('LAO ▶', `Swing the detector ${step}° toward the patient's left`, step, 0),
      nudge('▲ CRA', `Tilt the beam ${step}° toward the head`, 0, step),
      nudge('▼ CAU', `Tilt the beam ${step}° toward the feet`, 0, -step),
    ]),
    carmReadoutText,
  ]);

  // --- the device panel ---------------------------------------------------------------------------------------------------
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
  const fineLabel = el('label', { className: 'fine', attrs: { for: 'fine-toggle' } }, [fine, ' Fine control ', el('span', { className: 'keycap', text: 'Shift' })]);

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

  const dock = el('footer', { className: 'lab-dock' }, [dockTools, toolPanel, carmPanel]);

  // --- the left column: the six steps and the current one -----------------------------------------------------------------------
  const stageStep = el('p', { className: 'step-eyebrow' });
  const stageTitle = el('h2', { className: 'stage-title' });
  const stageGoal = el('p', { className: 'stage-goal' });
  const taskList = el('ul', { className: 'tasks' });
  const progressFill = el('div', { className: 'progress-fill' });
  const progress = el('div', { className: 'progress', attrs: { role: 'progressbar', 'aria-label': 'Case progress', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, [progressFill]);
  const hint = el('p', { className: 'hint' });
  const whyText = el('p', { className: 'why' });
  const why = el('details', { className: 'why-box' }, [el('summary', { text: 'Why this step?' }), whyText]);
  const stageRows = el('ol', { className: 'stage-list', attrs: { 'aria-label': 'All six steps' } });
  const stagePanel = el('section', { className: 'panel stage-panel' }, [
    el('h2', { className: 'panel-title', text: 'The case' }),
    progress,
    stageRows,
    el('div', { className: 'current-step' }, [stageStep, stageTitle, stageGoal, taskList, hint, why]),
  ]);

  // --- the right column: the patient and the mentor ---------------------------------------------------------------------------------
  const monitor = createMonitor();
  const mentorLog = el('ol', { className: 'mentor-log', attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Mentor' } });
  const mentorPanel = el('section', { className: 'panel mentor' }, [el('h2', { className: 'panel-title', text: 'Mentor (M)' }), mentorLog]);

  // --- overlays ---------------------------------------------------------------------------------------------------------------------------
  const helpBody = el('dl', { className: 'controls' }, CONTROLS.flatMap(([keys, action]) => [el('dt', {}, [keycaps(keys)]), el('dd', { text: action })]));
  const helpClose = button('Close', 'primary');
  helpClose.addEventListener('click', () => handlers.onUi('toggle-help'));
  const help = el('div', { className: 'overlay help hidden', attrs: { role: 'dialog', 'aria-label': 'Help' } }, [
    el('div', { className: 'overlay-panel' }, [el('h2', { text: 'Controls' }), helpBody, el('p', { className: 'status', text: LAB_LIMITS }), el('p', { className: 'status', text: LAB_TOUCH_HINT }), helpClose]),
  ]);

  const resume = button('Resume (Esc)', 'primary');
  const endCase = button('End the case', 'danger');
  resume.addEventListener('click', () => handlers.onUi('pause'));
  endCase.addEventListener('click', handlers.onEndCase);
  const pause = el('div', { className: 'overlay pause hidden', attrs: { role: 'dialog', 'aria-label': 'Paused' } }, [
    el('div', { className: 'overlay-panel' }, [el('h2', { text: PAUSE_TEXT }), el('p', { className: 'status', text: END_CASE_WARNING }), el('div', { className: 'actions' }, [resume, endCase])]),
  ]);
  const overlays = el('div', { className: 'overlays' }, [help, pause]);

  const root = el('main', { className: 'lab' }, [
    bar,
    el('div', { className: 'lab-body' }, [
      el('aside', { className: 'lab-left' }, [stagePanel]),
      el('section', { className: 'stage-wrap' }, [stage, viewSwitch, viewTools, demoBar, toast]),
      el('aside', { className: 'lab-right' }, [monitor.root, mentorPanel]),
    ]),
    dock,
    overlays,
  ]);

  // --- per-frame update ------------------------------------------------------------------------------------------------------------------
  let stageSignature = '';
  let mentorSignature = '';
  let rowSignature = '';
  let doneCount = 0;

  return {
    root,
    stage,
    overlays,
    setMeasureTip(lines: readonly string[] | null, x: number, y: number): void {
      if (!lines) {
        setClass(measureTip, 'hidden', true);
        return;
      }
      measureTip.replaceChildren(...lines.map((line, i) => el('div', { className: i === 0 ? 'tip-title' : '', text: line })));
      const width = stage.clientWidth;
      const left = x + 16 + 220 > width ? x - 16 - 220 : x + 16;
      measureTip.style.left = `${Math.max(4, left)}px`;
      measureTip.style.top = `${Math.max(4, y + 14)}px`;
      setClass(measureTip, 'hidden', false);
    },

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
              el('span', { className: 'row-mark', text: r.done ? '✓' : String(r.number) }),
              el('span', { className: 'row-title', text: r.title }),
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
        setClass(node, 'locked', !t.available);
        node.setAttribute('aria-disabled', String(!t.available));
        const active = t.active || (t.id === 'measure' && flags.measure);
        setClass(node, 'active', active);
        node.setAttribute('aria-pressed', String(active));
        // Available: the tool's rule. Locked: why, which is what the learner needs to know right now.
        node.title = t.available ? t.rule : (t.reason ?? '');
      }
      setClass(heparinButton, 'done', sim.patient.heparinGiven);

      // Stage panel.
      const stage = stageView(sim);
      const signature = `${stage.number}|${stage.tasks.map((t) => (t.done ? 1 : t.next ? 'n' : 0)).join('')}`;
      if (signature !== stageSignature) {
        stageSignature = signature;
        setText(stageStep, stage.finished ? 'Complete' : `Step ${stage.number} of ${stage.total}`);
        setText(stageTitle, stage.title);
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
      currentView = flags.view;
      setClass(view3d, 'on', flags.view === '3d');
      setClass(viewXray, 'on', flags.view === 'xray');
      view3d.setAttribute('aria-pressed', String(flags.view === '3d'));
      viewXray.setAttribute('aria-pressed', String(flags.view === 'xray'));
      setClass(labelsButton, 'on', flags.labels);
      labelsButton.setAttribute('aria-pressed', String(flags.labels));
      setClass(soundButton, 'on', flags.sound);
      soundButton.setAttribute('aria-pressed', String(flags.sound));
      setClass(followButton, 'on', flags.follow);
      followButton.setAttribute('aria-pressed', String(flags.follow));
      setClass(help, 'hidden', !flags.help);
      setClass(pause, 'hidden', !flags.paused);
    },
  };
}
