import { describeTarget } from '../anatomy/targets';
import { ANATOMY } from '../config/anatomy';
import { RULES } from '../config/rules';
import { act, flowing, initialField, tick, type Action, type FieldEvent, type FieldState } from '../procedure/field';
import { adviceNow, notesFor, type MentorNote } from '../procedure/mentor';
import { stageViews } from '../procedure/stages';
import { buildBrainScene } from '../scene/brainScene';
import { createMicroscope } from '../scene/microscope';
import { TOOLS, TOOL_BY_ID, toolForKey, type ToolId } from '../tools/tools';
import { cursorFor, iconElement } from './cursors';
import { fieldRows, type Row } from './fieldModel';
import './lab.css';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const STATUS_SECONDS = 4.5;
const LOG_LENGTH = 6;

/**
 * The operating-room screen: the microscope view, the six steps on the left, the mentor and the field readout on the
 * right, and the ten tools along the bottom (keys 1 to 9, then 0). The rules live in `procedure/`; this file only
 * connects them to the pointer, the keys and the scene. Vitals and bleeding arrive in a later milestone.
 */
export function renderLabScreen(root: HTMLElement, onLeave: () => void): void {
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
  const log: MentorNote[] = [];
  if (import.meta.env.DEV) {
    const hooks = window as unknown as { __brain?: unknown; __field?: () => FieldState };
    hooks.__brain = scene;
    hooks.__field = () => field;
  }

  // --- the top bar -----------------------------------------------------------------------------------------------
  const bar = node('header', 'lab-bar');
  const brand = node('div', 'brand');
  brand.append(node('strong', undefined, 'Brain Surgery'), node('span', undefined, ' · aneurysm clipping'));
  const note = node('p', 'bar-note', 'Educational demonstration only. Simplified anatomy, invented numbers. Not clinical training or medical advice.');
  const buttons = node('div', 'bar-buttons');
  const makeButton = (label: string, key: string, onClick: () => void, className = 'ghost'): HTMLButtonElement => {
    const button = node('button', className);
    button.append(document.createTextNode(label + ' '), node('kbd', undefined, key));
    button.addEventListener('click', onClick);
    return button;
  };
  const labelsButton = makeButton('Labels', 'L', () => {
    if (!scope) return;
    scope.setLabelsVisible(!scope.labelsVisible);
    labelsButton.classList.toggle('on', scope.labelsVisible);
  });
  labelsButton.classList.add('on');
  const reset = makeButton('Reset view', 'R', () => scope?.resetView());
  const leave = node('button', 'ghost', 'Leave');
  leave.addEventListener('click', () => {
    dispose();
    onLeave();
  });
  buttons.append(labelsButton, reset, leave);
  bar.append(brand, note, buttons);

  // --- the steps panel (left) --------------------------------------------------------------------------------------------
  const stepsPanel = node('section', 'panel steps-panel');
  stepsPanel.append(node('h2', undefined, 'The case'));
  const stepList = node('ol', 'steps');
  stepsPanel.append(stepList);

  const renderSteps = (): void => {
    const views = stageViews(field);
    const key = JSON.stringify(views.map((v) => [v.status, v.tasks.map((t) => t.done)]));
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
          for (const t of view.tasks) tasks.append(node('li', t.done ? 'task done' : 'task', `${t.done ? '✓ ' : '○ '}${t.task.text}`));
          item.append(tasks);
        }
        return item;
      }),
    );
  };

  // --- the mentor and the readout (right) ------------------------------------------------------------------------------------
  const mentorPanel = node('section', 'panel mentor-panel');
  mentorPanel.append(node('h2', undefined, 'Mentor'));
  const adviceEyebrow = node('p', 'advice-eyebrow');
  const adviceTitle = node('p', 'advice-title');
  const adviceHint = node('p', 'advice-hint');
  const adviceWhy = node('p', 'advice-why');
  const logList = node('ul', 'mentor-log');
  logList.setAttribute('aria-live', 'polite');
  mentorPanel.append(adviceEyebrow, adviceTitle, adviceHint, adviceWhy, logList);

  const renderMentor = (): void => {
    const advice = adviceNow(field);
    const key = JSON.stringify([advice, log.length]);
    if (key === lastAdvice) return;
    lastAdvice = key;
    adviceEyebrow.textContent = advice.eyebrow;
    adviceTitle.textContent = advice.title;
    adviceHint.textContent = advice.hint;
    adviceWhy.textContent = `Why: ${advice.why}`;
    logList.replaceChildren(...log.slice(-LOG_LENGTH).reverse().map((n) => node('li', `tone-${n.tone}`, n.text)));
  };

  const readoutPanel = node('section', 'panel readout');
  readoutPanel.append(node('h2', undefined, 'The field'));
  const rowList = node('dl', 'rows');
  readoutPanel.append(rowList);
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
  const hint = node('p', 'hint', 'Left-click uses the tool · I identifies what is under the pointer · right-drag looks around · scroll zooms');

  const say = (events: readonly FieldEvent[]): void => {
    const last = events.at(-1);
    if (!last) return;
    status.textContent = last.text;
    status.className = `field-status tone-${last.tone}`;
    statusLeft = STATUS_SECONDS;
  };

  // --- the dock: tools, identify, and the clip's own controls ----------------------------------------------------------------
  const dock = node('footer', 'lab-dock');
  const toolbar = node('div', 'toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Surgical tools');
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const def of TOOLS) {
    const button = node('button', 'tool');
    button.title = `${def.name} (${def.key}): ${def.hint}`;
    button.append(iconElement(def.id), node('span', 'tool-name', def.name), node('kbd', undefined, def.key));
    button.addEventListener('click', () => selectTool(def.id));
    toolbar.append(button);
    toolButtons.set(def.id, button);
  }
  const identifyButton = makeButton('Identify', 'I', () => armIdentify(!identifyArmed), 'tool identify');
  identifyButton.title = 'Identify (I): press I with the pointer on a structure, or click this and then click the structure.';
  toolbar.append(identifyButton);
  const toolHint = node('p', 'tool-hint');

  const clipBox = node('div', 'clip-options');
  clipBox.hidden = true;
  const clipText = node('span', 'clip-text');
  const clipButton = (label: string, title: string, action: () => void): HTMLButtonElement => {
    const button = node('button', 'mini', label);
    button.title = title;
    button.addEventListener('click', action);
    return button;
  };
  const setup = (patch: { variant?: 'straight' | 'curved'; angleDeg?: number; depth?: number }): void => apply({ type: 'setClip', ...patch });
  clipBox.append(
    clipButton('Straight / curved', 'V', () => setup({ variant: field.clipSetup.variant === 'straight' ? 'curved' : 'straight' })),
    clipButton('Turn left', 'A', () => setup({ angleDeg: field.clipSetup.angleDeg - RULES.clipAngleStepDeg })),
    clipButton('Turn right', 'D', () => setup({ angleDeg: field.clipSetup.angleDeg + RULES.clipAngleStepDeg })),
    clipButton('Deeper', 'W', () => setup({ depth: field.clipSetup.depth + RULES.clipDepthStep })),
    clipButton('Shallower', 'S', () => setup({ depth: field.clipSetup.depth - RULES.clipDepthStep })),
    clipText,
  );
  dock.append(toolbar, toolHint, clipBox);

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
    const now = field.clipSetup;
    clipText.textContent = `${now.variant}, ${now.angleDeg}°, depth ${Math.round(now.depth * 100)}%`;
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

  if (scope) {
    scope.onToolDown = (target) => {
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
    scope.onFrame = (dt) => {
      const ticked = tick(field, dt);
      if (pressed && TOOL_BY_ID[tool].hold) {
        const result = act(ticked, { type: 'hold', tool, target: scope.pointerTarget(), dt });
        commit(result.state, result.events);
        sync();
      } else {
        commit(ticked, []);
        if (field.tempClip.on || field.retraction > 0) showRows(fieldRows(field));
      }
      // The lobes move toward where the spatulas hold them rather than jumping there.
      shownOpening += (field.retraction - shownOpening) * (1 - Math.exp(-dt * 4));
      if (Math.abs(field.retraction - shownOpening) < 0.002) shownOpening = field.retraction;
      scene.setFissureOpening(shownOpening);
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
    const key = event.key.toLowerCase();
    const picked = toolForKey(event.key);
    if (picked) return selectTool(picked.id);
    if (key === 'l') return labelsButton.click();
    if (key === 'r') return reset.click();
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
    frame.append(stage, vignette, status, pointing, hint);
  } else {
    frame.append(node('p', 'no-webgl', 'This browser cannot show 3D (WebGL is unavailable). Try a current Chrome, Edge, Firefox or Safari.'));
  }
  const left = node('aside', 'lab-left');
  left.append(stepsPanel);
  const right = node('aside', 'lab-right');
  right.append(mentorPanel, readoutPanel);
  const body = node('div', 'lab-body');
  body.append(left, frame, right);
  const lab = node('div', 'lab');
  lab.append(bar, body, dock);
  root.replaceChildren(lab);
  selectTool(tool);
  sync();
  renderSteps();
  renderMentor();
}
