import { describeTarget } from '../anatomy/targets';
import { ANATOMY } from '../config/anatomy';
import { RULES } from '../config/rules';
import { act, flowing, initialField, tick, type Action, type FieldEvent, type FieldState } from '../procedure/field';
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

/**
 * The operating-room screen: the microscope view, the ten tools along the bottom (keys 1 to 9, then 0), a readout of
 * the field, and a line saying what the last action did. The rules live in `procedure/field.ts`; this file only
 * connects them to the pointer, the keys and the scene. Stages, vitals and bleeding arrive in later milestones.
 */
export function renderLabScreen(root: HTMLElement, onLeave: () => void): void {
  const scene = buildBrainScene(ANATOMY, 0);
  // For checking the scene from the browser console while developing; not present in a production build.
  if (import.meta.env.DEV) (window as unknown as { __brain?: unknown; __field?: () => FieldState }).__brain = scene;
  const stage = node('div', 'microscope');
  const scope = createMicroscope(stage, scene);

  let field: FieldState = initialField();
  if (import.meta.env.DEV) (window as unknown as { __field?: () => FieldState }).__field = () => field;
  let tool: ToolId = 'scissors';
  let pressed = false;
  let shownOpening = 0;
  let statusLeft = 0;
  let lastRows = '';
  let lastPointing = '';

  // --- the top bar -----------------------------------------------------------------------------------------------
  const bar = node('header', 'lab-bar');
  const brand = node('div', 'brand');
  brand.append(node('strong', undefined, 'Brain Surgery'), node('span', undefined, ' · aneurysm clipping'));
  const note = node('p', 'bar-note', 'Educational demonstration only. Simplified anatomy, invented numbers. Not clinical training or medical advice.');
  const buttons = node('div', 'bar-buttons');
  const makeButton = (label: string, key: string, onClick: () => void): HTMLButtonElement => {
    const button = node('button', 'ghost');
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

  // --- the field readout and status lines -----------------------------------------------------------------------------
  const readout = node('section', 'readout');
  readout.append(node('h2', undefined, 'The field'));
  const rowList = node('dl', 'rows');
  readout.append(rowList);
  const status = node('p', 'field-status');
  status.setAttribute('role', 'status');
  const pointing = node('p', 'pointing');
  const hint = node('p', 'hint', 'Left-click uses the tool · right-drag looks around · scroll zooms · arrow keys move');

  const showRows = (rows: readonly Row[]): void => {
    const key = JSON.stringify(rows);
    if (key === lastRows) return;
    lastRows = key;
    rowList.replaceChildren(
      ...rows.flatMap((row) => [node('dt', undefined, row.label), node('dd', `tone-${row.tone}`, row.value)]),
    );
  };

  const say = (events: readonly FieldEvent[]): void => {
    const last = events.at(-1);
    if (!last) return;
    status.textContent = last.text;
    status.className = `field-status tone-${last.tone}`;
    statusLeft = STATUS_SECONDS;
  };

  // --- the dock: tools, and the clip's own controls ---------------------------------------------------------------------
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

  // --- connecting the rules to the scene ------------------------------------------------------------------------------------
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
    field = result.state;
    say(result.events);
    sync();
  }

  if (import.meta.env.DEV) (window as unknown as { __apply?: (a: Action) => void }).__apply = apply;

  function selectTool(next: ToolId): void {
    tool = next;
    for (const [id, button] of toolButtons) {
      button.classList.toggle('selected', id === next);
      button.setAttribute('aria-pressed', String(id === next));
    }
    toolHint.textContent = `${TOOL_BY_ID[next].name}: ${TOOL_BY_ID[next].hint}`;
    clipBox.hidden = next !== 'clip';
    scope?.setCursor(cursorFor(next));
  }

  if (scope) {
    scope.onToolDown = (target) => {
      pressed = true;
      if (!TOOL_BY_ID[tool].hold) apply({ type: 'click', tool, target });
    };
    scope.onToolUp = () => {
      pressed = false;
    };
    scope.onFrame = (dt) => {
      field = tick(field, dt);
      if (pressed && TOOL_BY_ID[tool].hold) {
        const result = act(field, { type: 'hold', tool, target: scope.pointerTarget(), dt });
        field = result.state;
        say(result.events);
        sync();
      } else if (field.tempClip.on || field.retraction > 0) {
        showRows(fieldRows(field));
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

  // --- assembling ---------------------------------------------------------------------------------------------------------------
  const frame = node('div', 'frame');
  if (scope) {
    const vignette = node('div', 'vignette');
    vignette.setAttribute('aria-hidden', 'true');
    frame.append(stage, vignette, readout, status, pointing, hint);
  } else {
    frame.append(node('p', 'no-webgl', 'This browser cannot show 3D (WebGL is unavailable). Try a current Chrome, Edge, Firefox or Safari.'));
  }
  const lab = node('div', 'lab');
  lab.append(bar, frame, dock);
  root.replaceChildren(lab);
  selectTool(tool);
  sync();
}
