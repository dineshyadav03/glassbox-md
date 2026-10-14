/**
 * The operating-microscope viewer: a narrow-field camera with a headlight that moves with it, orbit limited to a
 * cone around the straight-on view, zoom, pan, anatomy labels as HTML, and the heartbeat swelling the arteries.
 * This is the only module that touches the renderer and the DOM; the geometry and maths it uses are tested apart.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ANATOMY } from '../config/anatomy';
import type { BrainScene } from './brainScene';
import { clampSwing, easeInOut, fovFor } from './cameraMath';

export interface Microscope {
  setLabelsVisible(visible: boolean): void;
  readonly labelsVisible: boolean;
  /** Fly back to the starting view. */
  resetView(): void;
  /** Called once per frame with the seconds since the last one (at most 0.25). */
  onFrame: ((dt: number) => void) | null;
  /** Heart rate for the pulse, beats per minute. */
  beatsPerMinute: () => number;
  dispose(): void;
}

/** Make a microscope view inside `container`, or return null if the browser cannot provide WebGL. */
export function createMicroscope(container: HTMLElement, scene: BrainScene): Microscope | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  const cam = ANATOMY.camera;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x07030a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute(
    'aria-label',
    'Operating-microscope view of the sylvian fissure with the carotid artery and its aneurysm. Drag to look around, scroll to zoom, right-drag to move.',
  );
  renderer.domElement.style.display = 'block';
  container.append(renderer.domElement);

  const three = new THREE.Scene();
  three.add(scene.root);
  three.add(new THREE.HemisphereLight(0xffe8e0, 0x2a0d12, 0.55));

  const camera = new THREE.PerspectiveCamera(cam.fovDeg, 1, 5, 1200);
  // The microscope's own light: it travels with the camera, so whatever you look at is lit from where you look.
  const headlight = new THREE.SpotLight(0xfff1e6, 6200, 0, 0.5, 0.55, 1.6);
  headlight.position.set(2, 3, 0);
  headlight.target.position.set(0, 0, -60);
  camera.add(headlight, headlight.target);
  three.add(camera);

  camera.position.set(...cam.position);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...cam.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = cam.minDistanceMm;
  controls.maxDistance = cam.maxDistanceMm;
  controls.screenSpacePanning = true;
  controls.zoomSpeed = 0.7;
  controls.rotateSpeed = 0.55;
  const swing = clampSwing(cam.maxSwingDeg);
  controls.minAzimuthAngle = -swing;
  controls.maxAzimuthAngle = swing;
  controls.minPolarAngle = Math.PI / 2 - swing;
  controls.maxPolarAngle = Math.PI / 2 + swing;
  controls.update();

  // --- labels -------------------------------------------------------------------------------------------
  const layer = document.createElement('div');
  layer.className = 'label-layer';
  container.append(layer);
  const elements = scene.labels.map((anchor) => {
    const node = document.createElement('span');
    node.className = anchor.emphasis ? 'anatomy-label emphasis' : 'anatomy-label';
    node.textContent = anchor.text;
    node.title = anchor.detail;
    layer.append(node);
    return node;
  });
  let showLabels = true;
  const scratch = new THREE.Vector3();

  const updateLabels = (width: number, height: number): void => {
    scene.root.updateMatrixWorld();
    scene.labels.forEach((anchor, i) => {
      const node = elements[i]!;
      scratch.set(...anchor.position).project(camera);
      if (!showLabels || scratch.z < -1 || scratch.z > 1 || Math.abs(scratch.x) > 0.96 || Math.abs(scratch.y) > 0.96) {
        node.style.display = 'none';
        return;
      }
      node.style.display = 'block';
      const x = ((scratch.x + 1) / 2) * width;
      const y = ((1 - scratch.y) / 2) * height;
      node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    });
  };

  // --- sizing ----------------------------------------------------------------------------------------------
  let width = 1;
  let height = 1;
  const resize = (): void => {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = width / height;
    camera.fov = fovFor(cam.fovDeg, camera.aspect);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // --- reset move ------------------------------------------------------------------------------------------
  let move: { from: THREE.Vector3; fromTarget: THREE.Vector3; start: number } | null = null;
  const home = new THREE.Vector3(...cam.position);
  const homeTarget = new THREE.Vector3(...cam.target);
  const cancelMove = (): void => {
    move = null;
  };
  renderer.domElement.addEventListener('pointerdown', cancelMove);

  // --- the loop --------------------------------------------------------------------------------------------
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const began = performance.now();
  let last = began;
  let frame = 0;
  const api: Microscope = {
    onFrame: null,
    beatsPerMinute: () => 72,
    setLabelsVisible(visible: boolean): void {
      showLabels = visible;
      if (!visible) for (const node of elements) node.style.display = 'none';
    },
    get labelsVisible(): boolean {
      return showLabels;
    },
    resetView(): void {
      move = { from: camera.position.clone(), fromTarget: controls.target.clone(), start: performance.now() };
    },
    dispose(): void {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', cancelMove);
      controls.dispose();
      scene.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      layer.remove();
    },
  };
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    api.onFrame?.(dt);
    if (move) {
      const t = easeInOut((now - move.start) / 700);
      camera.position.lerpVectors(move.from, home, t);
      controls.target.lerpVectors(move.fromTarget, homeTarget, t);
      if (t >= 1) move = null;
    }
    controls.update();
    scene.setPulse(reducedMotion ? 0 : ((now - began) / 1000) * (api.beatsPerMinute() / 60));
    renderer.render(three, camera);
    updateLabels(width, height);
  };
  frame = requestAnimationFrame(loop);
  return api;
}
