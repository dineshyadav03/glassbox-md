import { describeTarget } from '../anatomy/targets';
import { DopplerSound, type AudioContextLike } from '../audio/doppler';
import { ANATOMY } from '../config/anatomy';
import { RULES } from '../config/rules';
import { DemoRunner } from '../demo/autopilot';
import { getLang, saveLang, setLang, t, type MessageKey } from '../i18n';
import { act, dopplerReading, flowing, initialField, tick, type Action, type FieldEvent, type FieldState } from '../procedure/field';
import { debrief, summarise } from '../procedure/debrief';
import { adviceNow, notesFor, type MentorNote } from '../procedure/mentor';
import { allStagesDone, stageViews } from '../procedure/stages';
import { buildBrainScene } from '../scene/brainScene';
import { createMicroscope } from '../scene/microscope';
import { TOOLS, TOOL_BY_ID, toolForKey, type ToolId } from '../tools/tools';
import { cursorFor, iconElement } from './cursors';
import { clipSummary, fieldRows, type Row } from './fieldModel';
import { createMonitor } from './monitor';
import './lab.css';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const STATUS_SECONDS = 4.5;
const LOG_LENGTH = 6;
const DEMO_SPEEDS = [1, 2, 4] as const;

export interface LabOptions {
  /** Start with the autopilot performing the case. */
  readonly demo: boolean;
  /** Called when the language is switched, so the caller can keep other screens in step. */
  readonly onLanguage?: () => void;
}

/**
 * The operating-room screen: the microscope view, the six steps on the left, the monitor, mentor and field readout on
 * the right, and the ten tools along the bottom (keys 1 to 9, then 0). The rules live in `procedure/` and `physics/`;
 * this file only connects them to the pointer, the keys and the scene, and draws the demo bar and the debrief.
 */
export function renderLabScreen(root: HTMLElement, onLeave: () => void, options: LabOptions = { demo: false }): void {
  const scene = buildBrainScene(ANATOMY, 0);
  const stage = node('div', 'microscope');
  const scope = createMicroscope(stage, scene);

  let field: FieldState = initialField();
  let tool: ToolId = 'scissors';
  let pressed = false;
  let identifyArmed = false;
  let shownOpening = 0;
  let statusLeft = 0;
  let lastRows = '';
  let lastSteps = '';
  let lastAdvice = '';
  let lastPointing = '';
  let demo: DemoRunner | null = options.demo ? new DemoRunner() : null;
  let demoSpeed = 1;
  let narrationKey: MessageKey | null = null;
  let finishTimer = 0;
  let debriefOpen = false;
  const log: MentorNote[] = [];
  const refreshers: (() => void)[] = [];
  if (import.meta.env.DEV) {
    const hooks = window as unknown as { __brain?: unknown; __field?: () => FieldState; __apply?: (a: Action) => void };
    hooks.__brain = scene;
    hooks.__field = () => field;
  }

  // A button with a label that follows the language, and an optional key hint.
  const keyButton = (labelKey: MessageKey, key: string | null, onClick: () => void, className = 'ghost'): HTMLButtonElement => {
    const button = node('button', className);
    const label = document.createTextNode('');
    button.append(label);
    if (key) button.append(node('kbd', undefined, key));
    button.addEventListener('click', onClick);
    refreshers.push(() => {
      label.textContent = t(labelKey) + (key ? ' ' : '');
    });
    return button;
  };

  // --- the top bar -----------------------------------------------------------------------------------------------
  const bar = node('header', 'lab-bar');
  const brand = node('div', 'brand');
  const brandTitle = node('strong');
  const brandSub = node('span');
  brand.append(brandTitle, brandSub);
  const note = node('p', 'bar-note');
  const buttons = node('div', 'bar-buttons');
  const labelsButton = keyButton('bar.labels', 'L', () => {
    if (!scope) return;
    scope.setLabelsVisible(!scope.labelsVisible);
    labelsButton.classList.toggle('on', scope.labelsVisible);
  });
  labelsButton.classList.add('on');
  const sound = new DopplerSound(() => new AudioContext() as unknown as AudioContextLike);
  const soundButton = keyButton('bar.sound', 'N', () => {
    sound.enabled = !sound.enabled;
    soundButton.classList.toggle('on', sound.enabled);
  });
  soundButton.classList.add('on');
  const reset = keyButton('bar.reset', 'R', () => scope?.resetView());
  const finish = keyButton('bar.finish', null, () => openDebrief(), 'ghost finish');
  const language = keyButton('bar.language', null, () => switchLanguage());
  const leave = keyButton('bar.leave', null, () => {
    dispose();
    onLeave();
  });
  buttons.append(labelsButton, soundButton, reset, finish, language, leave);
  bar.append(brand, note, buttons);
  refreshers.push(() => {
    brandTitle.textContent = t('bar.title');
    brandSub.textContent = t('bar.subtitle');
    note.textContent = t('bar.note');
    language.title = t('bar.languageTitle');
    language.setAttribute('lang', getLang() === 'en' ? 'ja' : 'en');
  });

  // --- the steps panel (left) --------------------------------------------------------------------------------------------
  const stepsPanel = node('section', 'panel steps-panel');
  const stepsHeading = node('h2');
  const stepList = node('ol', 'steps');
  stepsPanel.append(stepsHeading, stepList);
  refreshers.push(() => {
    stepsHeading.textContent = t('panel.case');
    lastSteps = '';
  });

  const renderSteps = (): void => {
    const views = stageViews(field);
    const key = JSON.stringify(views.map((v) => [v.status, v.tasks.map((x) => x.done)]));
    if (key === lastSteps) return;
    lastSteps = key;
    stepList.replaceChildren(
      ...views.map((view) => {
        const item = node('li', `step ${view.status}`);
        const head = node('div', 'step-head');
        head.append(node('span', 'step-num', view.status === 'done' ? '✓' : String(view.stage.number)), node('span', 'step-title', view.stage.title));
        item.append(head);
        if (view.status === 'current') {
          const tasks = node('ul', 'tasks');
          for (const x of view.tasks) tasks.append(node('li', x.done ? 'task done' : 'task', `${x.done ? '✓ ' : '○ '}${x.task.text}`));
          item.append(tasks);
        }
        return item;
      }),
    );
  };

  // --- the monitor, mentor and readout (right) ---------------------------------------------------------------------------------
  const monitor = createMonitor();
  const mentorPanel = node('section', 'panel mentor-panel');
  const mentorHeading = node('h2');
  const adviceEyebrow = node('p', 'advice-eyebrow');
  const adviceTitle = node('p', 'advice-title');
  const adviceHint = node('p', 'advice-hint');
  const adviceWhy = node('p', 'advice-why');
  const logList = node('ul', 'mentor-log');
  logList.setAttribute('aria-live', 'polite');
  mentorPanel.append(mentorHeading, adviceEyebrow, adviceTitle, adviceHint, adviceWhy, logList);
  refreshers.push(() => {
    mentorHeading.textContent = t('panel.mentor');
    lastAdvice = '';
  });

  const renderMentor = (): void => {
    const advice = adviceNow(field);
    const key = JSON.stringify([advice, log.length]);
    if (key === lastAdvice) return;
    lastAdvice = key;
    adviceEyebrow.textContent = advice.eyebrow;
    adviceTitle.textContent = advice.title;
    adviceHint.textContent = advice.hint;
    adviceWhy.textContent = t('panel.whyPrefix', { why: advice.why });
    logList.replaceChildren(...log.slice(-LOG_LENGTH).reverse().map((n) => node('li', `tone-${n.tone}`, n.text)));
  };

  const readoutPanel = node('section', 'panel readout');
  const readoutHeading = node('h2');
  const rowList = node('dl', 'rows');
  readoutPanel.append(readoutHeading, rowList);
  refreshers.push(() => {
    readoutHeading.textContent = t('panel.field');
    lastRows = '';
  });
  const showRows = (rows: readonly Row[]): void => {
    const key = JSON.stringify(rows);
    if (key === lastRows) return;
    lastRows = key;
    rowList.replaceChildren(...rows.flatMap((row) => [node('dt', undefined, row.label), node('dd', `tone-${row.tone}`, row.value)]));
  };

  // --- status lines over the view -------------------------------------------------------------------------------------------
  const status = node('p', 'field-status');
  status.setAttribute('role', 'status');
  const pointing = node('p', 'pointing');
  const hint = node('p', 'hint');
  refreshers.push(() => {
    hint.textContent = t('hint.controls');
  });

  const say = (events: readonly FieldEvent[]): void => {
    const last = events.at(-1);
    if (!last) return;
    status.textContent = last.text;
    status.className = `field-status tone-${last.tone}`;
    statusLeft = STATUS_SECONDS;
  };

  // --- the demo bar -------------------------------------------------------------------------------------------------------------
  const demoBar = node('div', 'demo-bar');
  demoBar.hidden = demo === null;
  const demoTitle = node('strong', 'demo-title');
  const demoText = node('span', 'demo-text');
  const demoControls = node('span', 'demo-controls');
  const speedButtons = DEMO_SPEEDS.map((speed) => {
    const button = node('button', 'mini', `${speed}×`);
    button.addEventListener('click', () => {
      demoSpeed = speed;
      renderDemoBar();
    });
    return button;
  });
  const takeOver = keyButton('demo.take', null, () => stopDemo(), 'mini take');
  demoControls.append(...speedButtons, takeOver);
  demoBar.append(demoTitle, demoText, demoControls);
  const renderDemoBar = (): void => {
    demoBar.hidden = demo === null;
    demoTitle.textContent = t('demo.title');
    demoText.textContent = narrationKey ? t(narrationKey) : t('demo.hint');
    DEMO_SPEEDS.forEach((speed, i) => speedButtons[i]!.classList.toggle('selected', speed === demoSpeed));
  };
  refreshers.push(renderDemoBar);

  // --- the dock: tools, identify, and the clip's own controls ----------------------------------------------------------------
  const dock = node('footer', 'lab-dock');
  const toolbar = node('div', 'toolbar');
  toolbar.setAttribute('role', 'toolbar');
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const def of TOOLS) {
    const button = node('button', 'tool');
    const name = node('span', 'tool-name');
    button.append(iconElement(def.id), name, node('kbd', undefined, def.key));
    button.addEventListener('click', () => selectTool(def.id));
    toolbar.append(button);
    toolButtons.set(def.id, button);
    refreshers.push(() => {
      name.textContent = def.name;
      button.title = `${def.name} (${def.key}): ${def.hint}`;
    });
  }
  const identifyButton = keyButton('dock.identify', 'I', () => armIdentify(!identifyArmed), 'tool identify');
  toolbar.append(identifyButton);
  refreshers.push(() => {
    identifyButton.title = t('dock.identifyTitle');
    toolbar.setAttribute('aria-label', t('dock.toolbar'));
  });
  const toolHint = node('p', 'tool-hint');

  const clipBox = node('div', 'clip-options');
  clipBox.hidden = true;
  const clipText = node('span', 'clip-text');
  const setup = (patch: { variant?: 'straight' | 'curved'; angleDeg?: number; depth?: number }): void => apply({ type: 'setClip', ...patch });
  const clipControl = (labelKey: MessageKey, title: string, action: () => void): HTMLButtonElement => {
    const button = keyButton(labelKey, null, action, 'mini');
    button.title = title;
    return button;
  };
  clipBox.append(
    clipControl('clip.flip', 'V', () => setup({ variant: field.clipSetup.variant === 'straight' ? 'curved' : 'straight' })),
    clipControl('clip.left', 'A', () => setup({ angleDeg: field.clipSetup.angleDeg - RULES.clipAngleStepDeg })),
    clipControl('clip.right', 'D', () => setup({ angleDeg: field.clipSetup.angleDeg + RULES.clipAngleStepDeg })),
    clipControl('clip.deeper', 'W', () => setup({ depth: field.clipSetup.depth + RULES.clipDepthStep })),
    clipControl('clip.shallower', 'S', () => setup({ depth: field.clipSetup.depth - RULES.clipDepthStep })),
    clipText,
  );
  dock.append(toolbar, toolHint, clipBox);

  // --- the debrief overlay ------------------------------------------------------------------------------------------------------
  const overlay = node('div', 'overlay');
  overlay.hidden = true;
  const renderDebrief = (): void => {
    const d = debrief(summarise(field));
    const panel = node('section', `debrief grade-${d.grade}`);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', t('debrief.title'));
    const head = node('div', 'debrief-head');
    head.append(node('h2', undefined, t('debrief.title')), node('p', 'debrief-grade', d.gradeLabel), node('p', 'debrief-score', t('debrief.scoreLine', { score: d.score })));
    const items = node('ul', 'debrief-items');
    for (const item of d.items) {
      const row = node('li', `tone-${item.tone}`);
      row.append(node('span', 'item-label', item.label), node('span', 'item-value', item.value));
      if (item.max > 0) row.append(node('span', 'item-points', t('debrief.points', { points: item.points, max: item.max })));
      items.append(row);
    }
    const tips = node('ul', 'debrief-tips');
    for (const tip of d.tips) tips.append(node('li', undefined, tip));
    const actions = node('div', 'debrief-actions');
    const keep = node('button', 'primary', t('debrief.keep'));
    keep.addEventListener('click', () => closeDebrief());
    const again = node('button', undefined, t('debrief.again'));
    again.addEventListener('click', () => {
      dispose();
      renderLabScreen(root, onLeave, { demo: false, ...(options.onLanguage ? { onLanguage: options.onLanguage } : {}) });
    });
    const out = node('button', undefined, t('debrief.leave'));
    out.addEventListener('click', () => {
      dispose();
      onLeave();
    });
    actions.append(keep, again, out);
    panel.append(head, node('p', 'debrief-summary', d.summary), items, node('h3', undefined, t('debrief.tips')), tips, node('p', 'debrief-note', t('debrief.disclaimer')), actions);
    overlay.replaceChildren(panel);
    keep.focus();
  };
  function openDebrief(): void {
    stopDemo();
    debriefOpen = true;
    overlay.hidden = false;
    renderDebrief();
  }
  function closeDebrief(): void {
    debriefOpen = false;
    overlay.hidden = true;
  }

  // --- connecting the rules to the scene ----------------------------------------------------------------------------------------
  /** Make `next` the field, tell the mentor what changed, and show what the action said. */
  function commit(next: FieldState, events: readonly FieldEvent[]): void {
    const prev = field;
    field = next;
    const notes = notesFor(prev, next, events);
    if (notes.length > 0) log.push(...notes);
    say(events);
    if (notes.length > 0) {
      const last = notes[notes.length - 1]!;
      status.textContent = last.text;
      status.className = `field-status tone-${last.tone}`;
      statusLeft = STATUS_SECONDS;
    }
    renderSteps();
    renderMentor();
  }

  function sync(): void {
    for (const segment of ANATOMY.arachnoid.segments) scene.setArachnoidCut(segment.id, field.cut.includes(segment.id));
    scene.setOozes(field.oozes.map((o) => ({ id: o.id, on: o.on })));
    scene.setTempClip(field.tempClip.on);
    scene.setAppliedClip(field.clip);
    scene.setFieldView(field.view, new Set<string>(flowing(field)));
    scope?.setEndoscope(field.endoscope);
    clipText.textContent = clipSummary(field.clipSetup);
    showRows(fieldRows(field));
  }

  function apply(action: Action): void {
    const result = act(field, action);
    commit(result.state, result.events);
    sync();
  }
  if (import.meta.env.DEV) (window as unknown as { __apply?: (a: Action) => void }).__apply = apply;

  function armIdentify(on: boolean): void {
    identifyArmed = on;
    identifyButton.classList.toggle('selected', on);
    scope?.setCursor(on ? 'help' : cursorFor(tool));
  }

  function selectTool(next: ToolId): void {
    tool = next;
    for (const [id, button] of toolButtons) {
      button.classList.toggle('selected', id === next);
      button.setAttribute('aria-pressed', String(id === next));
    }
    toolHint.textContent = `${TOOL_BY_ID[next].name}: ${TOOL_BY_ID[next].hint}`;
    clipBox.hidden = next !== 'clip';
    armIdentify(false);
  }

  // --- language -------------------------------------------------------------------------------------------------------------------
  function refreshText(): void {
    document.documentElement.lang = getLang();
    for (const refresh of refreshers) refresh();
    toolHint.textContent = `${TOOL_BY_ID[tool].name}: ${TOOL_BY_ID[tool].hint}`;
    monitor.relabel();
    scope?.relabel();
    sync();
    renderSteps();
    renderMentor();
    if (debriefOpen) renderDebrief();
  }
  function switchLanguage(): void {
    const next = getLang() === 'en' ? 'ja' : 'en';
    setLang(next);
    saveLang(next);
    refreshText();
    options.onLanguage?.();
  }

  // --- the demo ---------------------------------------------------------------------------------------------------------------------
  function stopDemo(): void {
    if (!demo) return;
    demo = null;
    narrationKey = null;
    finishTimer = 0;
    renderDemoBar();
  }

  function runDemo(dt: number): number {
    if (!demo) return dt;
    const scaled = dt * demoSpeed;
    const out = demo.step(scaled);
    if (out.tool) selectTool(out.tool);
    if (out.narration) {
      narrationKey = out.narration;
      renderDemoBar();
    }
    if (out.camera === 'overview') scope?.resetView();
    if (out.camera === 'neck') scope?.flyTo(scene.neckCentre, 70);
    field = tick(field, scaled);
    for (const action of out.actions) apply(action);
    if (out.finished) {
      finishTimer += dt;
      if (finishTimer > 1.2) openDebrief();
    }
    return scaled;
  }

  if (scope) {
    scope.onToolDown = (target) => {
      if (demo) stopDemo();
      if (identifyArmed) {
        apply({ type: 'identify', target });
        armIdentify(false);
        return;
      }
      pressed = true;
      if (!TOOL_BY_ID[tool].hold) apply({ type: 'click', tool, target });
    };
    scope.onToolUp = () => {
      pressed = false;
    };
    scope.beatsPerMinute = () => field.vitals.hr;
    scope.onFrame = (dt) => {
      let step = dt;
      if (demo) {
        step = runDemo(dt);
      } else {
        const ticked = tick(field, dt);
        if (pressed && TOOL_BY_ID[tool].hold) {
          const result = act(ticked, { type: 'hold', tool, target: scope.pointerTarget(), dt });
          commit(result.state, result.events);
          sync();
        } else {
          commit(ticked, []);
          if (field.tempClip.on || field.retraction > 0) showRows(fieldRows(field));
        }
      }
      // The lobes move toward where the spatulas hold them rather than jumping there.
      shownOpening += (field.retraction - shownOpening) * (1 - Math.exp(-step * 4));
      if (Math.abs(field.retraction - shownOpening) < 0.002) shownOpening = field.retraction;
      scene.setFissureOpening(shownOpening);
      scene.setBlood(field.pooled, field.ruptured && !(field.clip), field.time);
      const probing = pressed && tool === 'doppler' && dopplerReading(field, scope.pointerTarget()).flow;
      sound.tick(dt, probing, field.vitals.hr);
      monitor.update(
        { vitals: field.vitals, eblMl: field.ebl, seconds: field.time, tempClipOn: field.tempClip.on, tempClipSeconds: field.tempClip.seconds },
        step,
      );
      finish.classList.toggle('ready', allStagesDone(field));
      statusLeft = Math.max(0, statusLeft - dt);
      if (statusLeft === 0 && status.textContent) {
        status.textContent = '';
        status.className = 'field-status';
      }
      const name = describeTarget(scope.pointerTarget());
      if (name !== lastPointing) {
        lastPointing = name;
        pointing.textContent = name;
      }
    };
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && debriefOpen) return closeDebrief();
    if (debriefOpen) return;
    if (demo) stopDemo();
    const key = event.key.toLowerCase();
    const picked = toolForKey(event.key);
    if (picked) return selectTool(picked.id);
    if (key === 'l') return labelsButton.click();
    if (key === 'r') return reset.click();
    if (key === 'n') return soundButton.click();
    if (key === 'i' && scope) return apply({ type: 'identify', target: scope.pointerTarget() });
    if (key === 'backspace') return apply({ type: 'removeClip' });
    if (tool !== 'clip') return;
    if (key === 'v') setup({ variant: field.clipSetup.variant === 'straight' ? 'curved' : 'straight' });
    else if (key === 'a') setup({ angleDeg: field.clipSetup.angleDeg - RULES.clipAngleStepDeg });
    else if (key === 'd') setup({ angleDeg: field.clipSetup.angleDeg + RULES.clipAngleStepDeg });
    else if (key === 'w') setup({ depth: field.clipSetup.depth + RULES.clipDepthStep });
    else if (key === 's') setup({ depth: field.clipSetup.depth - RULES.clipDepthStep });
  };
  window.addEventListener('keydown', onKey);

  function dispose(): void {
    window.removeEventListener('keydown', onKey);
    scope?.dispose();
  }

  // --- assembling -----------------------------------------------------------------------------------------------------------------
  const frame = node('section', 'frame');
  if (scope) {
    const vignette = node('div', 'vignette');
    vignette.setAttribute('aria-hidden', 'true');
    frame.append(stage, vignette, demoBar, status, pointing, hint);
  } else {
    frame.append(node('p', 'no-webgl', t('noWebgl')));
  }
  const left = node('aside', 'lab-left');
  left.append(stepsPanel);
  const right = node('aside', 'lab-right');
  right.append(monitor.root, mentorPanel, readoutPanel);
  const body = node('div', 'lab-body');
  body.append(left, frame, right);
  const lab = node('div', 'lab');
  lab.append(bar, body, dock, overlay);
  root.replaceChildren(lab);
  selectTool(tool);
  refreshText();
}
