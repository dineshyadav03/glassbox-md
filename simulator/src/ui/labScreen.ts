/**
 * The lab screen: owns the running `Simulation`, steps it every frame from what is held, draws it
 * through the device view and the 3D viewer, and keeps the HUD in step. Everything it decides lives in
 * modules that are unit tested; this file only connects them to the browser (events, frames, focus).
 */
import { buildAnatomyScene } from '../scene/anatomyScene';
import { focusPoint, suggestedDistance } from '../scene/deviceMath';
import { createDeviceView } from '../scene/devices';
import { createViewer } from '../scene/viewer';
import { act, createSimulation, tick, type Action, type Simulation } from '../engine/simulation';
import { createDebrief } from './debriefScreen';
import { el } from './dom';
import { createHud, type HudFlags } from './hud';
import { monitorView } from './hudModel';
import { InputState, isHeldKey, keyPress, type UiCommand } from './input';
import { NO_WEBGL_MESSAGE } from './labContent';
import './lab.css';

/** The longest slice of time given to the simulation in one step, seconds. */
const MAX_STEP = 0.05;

/**
 * Show the lab in `root`. `onBack` is called when the user leaves; by then the renderer, the frame loop
 * and every listener have been released.
 */
export function renderLabScreen(root: HTMLElement, onBack: () => void): void {
  let sim: Simulation = createSimulation();
  let flags: HudFlags = { paused: false, labels: true, follow: true, help: false, mentor: true };
  let lastCameraKey = '';
  let debriefShown = false;
  let disposed = false;
  const input = new InputState();

  /** Release the renderer, the frame loop and the listeners. Returns false if this was already done. */
  const teardown = (): boolean => {
    if (disposed) return false;
    disposed = true;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    viewer?.dispose();
    devices.dispose();
    return true;
  };

  const leave = (): void => {
    if (teardown()) onBack();
  };

  const restart = (): void => {
    if (teardown()) renderLabScreen(root, onBack);
  };

  const apply = (action: Action): void => {
    sim = act(sim, action);
    refocus();
  };

  const runUi = (command: UiCommand): void => {
    switch (command) {
      case 'toggle-labels':
        viewer?.setLabelsVisible(!viewer.labelsVisible);
        flags = { ...flags, labels: viewer?.labelsVisible ?? false };
        break;
      case 'toggle-follow':
        flags = { ...flags, follow: !flags.follow };
        if (flags.follow) refocus(true);
        break;
      case 'toggle-help':
        flags = { ...flags, help: !flags.help };
        break;
      case 'toggle-mentor':
        flags = { ...flags, mentor: !flags.mentor };
        break;
      case 'pause':
        if (flags.help) {
          flags = { ...flags, help: false };
        } else if (!sim.ended) {
          flags = { ...flags, paused: !flags.paused };
          input.releaseAll();
        }
        break;
    }
  };

  const hud = createHud({
    onAction: apply,
    onHold: (button, down) => input.setHold(button, down),
    onUi: runUi,
    onFine: (on) => {
      input.fineToggle = on;
    },
    onFrameHeart: () => {
      flags = { ...flags, follow: false };
      viewer?.frameHeart();
    },
    onFrameRoute: () => {
      flags = { ...flags, follow: false };
      viewer?.frameRoute();
    },
    onEndCase: () => {
      flags = { ...flags, paused: false };
      apply({ type: 'end-case' });
    },
    onBack: leave,
  });
  root.replaceChildren(hud.root);

  const anatomy = buildAnatomyScene();
  const devices = createDeviceView(anatomy);

  /** Move the camera when the tool or the stage of the case calls for a different distance. */
  function refocus(force = false): void {
    if (!viewer || !flags.follow) return;
    const distance = suggestedDistance(sim);
    const key = `${sim.tool}|${distance}`;
    if (!force && key === lastCameraKey) return;
    lastCameraKey = key;
    viewer.focus(focusPoint(sim), distance);
  }

  const step = (dt: number): void => {
    if (flags.paused || sim.ended || dt <= 0) return;
    const controls = input.controls(performance.now());
    const pieces = Math.max(1, Math.ceil(dt / MAX_STEP));
    for (let i = 0; i < pieces; i++) sim = tick(sim, controls, dt / pieces);
  };

  const viewer = createViewer(hud.stage, anatomy, {
    onFrame: (dt) => {
      step(dt);
      devices.update(sim);
      hud.update(sim, flags, dt);
      if (sim.ended && sim.debrief && !debriefShown) {
        debriefShown = true;
        input.releaseAll();
        hud.overlays.append(createDebrief(sim.debrief, sim, { onRestart: restart, onBack: leave }));
      }
    },
    followPoint: () => (flags.follow && !flags.paused ? focusPoint(sim) : null),
    onWheel: (deltaY) => input.wheel(deltaY, performance.now()),
    beatsPerMinute: () => monitorView(sim).heartRate,
  });

  if (!viewer) {
    anatomy.dispose();
    const message = el('p', { className: 'status', text: NO_WEBGL_MESSAGE });
    message.setAttribute('role', 'alert');
    hud.stage.replaceChildren(message);
  } else {
    refocus(true);
  }

  // --- keyboard ----------------------------------------------------------------------------------------------------
  function onKeyDown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const typing = target instanceof HTMLSelectElement || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (typing && event.key !== 'Escape') return;
    if (sim.ended && event.key !== 'Escape') return;

    const key = event.key;
    if (isHeldKey(key)) {
      if (key === ' ') event.preventDefault();
      if (!flags.paused) input.keyDown(key);
      return;
    }
    if (event.repeat) return;
    const result = keyPress(key, event.shiftKey);
    if (!result) return;
    event.preventDefault();
    if (result.kind === 'ui') runUi(result.command);
    else if (!flags.paused) apply(result.action);
  }

  function onKeyUp(event: KeyboardEvent): void {
    input.keyUp(event.key);
  }

  function onBlur(): void {
    input.releaseAll();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

}
