import { buildBrainScene } from '../scene/brainScene';
import { createMicroscope, type Microscope } from '../scene/microscope';
import './lab.css';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * The operating-room screen. M1 shows the microscope view only: the field, the anatomy labels, and a few viewing
 * controls. Tools, stages and vitals arrive in the next milestones.
 */
export function renderLabScreen(root: HTMLElement, onLeave: () => void): void {
  const scene = buildBrainScene();
  // For checking the scene from the browser console while developing; not present in a production build.
  if (import.meta.env.DEV) (window as unknown as { __brain?: unknown }).__brain = scene;
  const stage = node('div', 'microscope');
  const scope = createMicroscope(stage, scene);

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

  const status = node('p', 'field-status');
  status.setAttribute('role', 'status');
  const say = (text: string): void => {
    status.textContent = text;
  };

  const labelsButton = makeButton('Labels', 'L', () => {
    if (!scope) return;
    scope.setLabelsVisible(!scope.labelsVisible);
    labelsButton.classList.toggle('on', scope.labelsVisible);
  });
  labelsButton.classList.add('on');
  const fissure = makeButton('Close fissure', 'O', () => toggleFissure());
  const reset = makeButton('Reset view', 'R', () => scope?.resetView());
  const leave = node('button', 'ghost', 'Leave');
  leave.addEventListener('click', () => {
    dispose();
    onLeave();
  });
  buttons.append(labelsButton, fissure, reset, leave);
  bar.append(brand, note, buttons);

  const hint = node('p', 'hint', 'Drag to look around · scroll to zoom · right-drag to move');

  function toggleFissure(): void {
    const open = scene.fissureOpening < 0.5;
    scene.setFissureOpening(open ? 1 : 0);
    fissure.firstChild!.textContent = (open ? 'Close fissure' : 'Open fissure') + ' ';
    say(open ? 'The fissure is open and held by the spatulas.' : 'The fissure is closed: the lobes lie together.');
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'l') labelsButton.click();
    else if (key === 'o') fissure.click();
    else if (key === 'r') reset.click();
  };
  window.addEventListener('keydown', onKey);

  function dispose(): void {
    window.removeEventListener('keydown', onKey);
    (scope as Microscope | null)?.dispose();
  }

  const frame = node('div', 'frame');
  if (scope) {
    const vignette = node('div', 'vignette');
    vignette.setAttribute('aria-hidden', 'true');
    frame.append(stage, vignette, hint, status);
  } else {
    frame.append(node('p', 'no-webgl', 'This browser cannot show 3D (WebGL is unavailable). Try a current Chrome, Edge, Firefox or Safari.'));
  }
  const lab = node('div', 'lab');
  lab.append(bar, frame);
  root.replaceChildren(lab);
}
