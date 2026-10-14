/**
 * The operating-microscope viewer: a narrow-field camera with a headlight that moves with it, orbit limited to a
 * cone around the straight-on view, zoom, pan, anatomy labels as HTML, and the heartbeat swelling the arteries.
 * This is the only module that touches the renderer and the DOM; the geometry and maths it uses are tested apart.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ANATOMY } from '../config/anatomy';
import { labelAnchors, type LabelAnchor } from '../anatomy/labels';
import { t as tr } from '../i18n';
import { classifyHit } from '../anatomy/targets';
import { NO_TARGET, type Target } from '../procedure/field';
import type { BrainScene } from './brainScene';
import { clampSwing, easeInOut, fovFor } from './cameraMath';

export interface Microscope {
  /** What is under the pointer right now (recomputed every frame while the pointer is over the view). */
  pointerTarget(): Target;
  /** Called when the primary button goes down or up over the view. */
  onToolDown: ((target: Target) => void) | null;
  onToolUp: (() => void) | null;
  /** The cursor over the view, a CSS `cursor` value. */
  setCursor(cursor: string): void;
  /** Show or hide the small endoscope view, drawn in a corner of the canvas. */
  setEndoscope(on: boolean): void;
  setLabelsVisible(visible: boolean): void;
  readonly labelsVisible: boolean;
  /** Fly back to the starting view. */
  resetView(): void;
  /** Fly to look at a point from the usual direction, `distance` mm away. */
  flyTo(point: readonly [number, number, number], distance: number): void;
  /** Redraw the words in the view (labels, the endoscope caption, the description) after its words change. */
  relabel(): void;
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
  renderer.domElement.setAttribute('aria-label', tr('view.aria'));
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
  // The primary button belongs to the tool. Right-drag looks around, middle-drag moves, the arrow keys move too.
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.listenToKeyEvents(window);
  controls.keyPanSpeed = 14;
  controls.update();
  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

  // --- pointing ----------------------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  let current: Target = NO_TARGET;
  const aim = (): Target => {
    if (!pointerInside) return NO_TARGET;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      scene.pickables().filter((mesh) => mesh.visible),
      false,
    );
    const first = hits[0];
    return first ? classifyHit(first.object.name, [first.point.x, first.point.y, first.point.z]) : NO_TARGET;
  };
  const onPointerMove = (event: PointerEvent): void => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    pointerInside = true;
  };
  const onPointerLeave = (): void => {
    pointerInside = false;
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    onPointerMove(event);
    current = aim();
    api.onToolDown?.(current);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.button === 0) api.onToolUp?.();
  };
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);

  // --- the endoscope inset ----------------------------------------------------------------------------------------
  let endoscopeOn = false;
  const insetFrame = document.createElement('div');
  insetFrame.className = 'endoscope-frame';
  insetFrame.hidden = true;
  const insetLabel = document.createElement('span');
  insetLabel.textContent = tr('endoscope.label');
  insetFrame.append(insetLabel);
  container.append(insetFrame);
  const endoscope = new THREE.PerspectiveCamera(55, 1, 0.5, 400);
  endoscope.position.set(...scene.endoscopeView.position);
  endoscope.lookAt(...scene.endoscopeView.target);
  const insetRect = (): { x: number; y: number; size: number } => {
    const size = Math.round(Math.min(width * 0.34, height * 0.34, 260));
    return { x: width - size - 14, y: 14, size };
  };

  // --- labels -------------------------------------------------------------------------------------------
  const layer = document.createElement('div');
  layer.className = 'label-layer';
  container.append(layer);
  let anchors: readonly LabelAnchor[] = scene.labels;
  let elements: HTMLElement[] = [];
  const buildLabels = (): void => {
    layer.replaceChildren();
    elements = anchors.map((anchor) => {
      const node = document.createElement('span');
      node.className = anchor.emphasis ? 'anatomy-label emphasis' : 'anatomy-label';
      node.textContent = anchor.text;
      node.title = anchor.detail;
      layer.append(node);
      return node;
    });
  };
  buildLabels();
  let showLabels = true;
  const scratch = new THREE.Vector3();

  const updateLabels = (width: number, height: number): void => {
    scene.root.updateMatrixWorld();
    anchors.forEach((anchor, i) => {
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
    const rect = insetRect();
    insetFrame.style.cssText = `left:${rect.x}px;bottom:${rect.y}px;width:${rect.size}px;height:${rect.size}px`;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // --- reset move ------------------------------------------------------------------------------------------
  let move: { from: THREE.Vector3; fromTarget: THREE.Vector3; to: THREE.Vector3; toTarget: THREE.Vector3; start: number } | null = null;
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
    onToolDown: null,
    onToolUp: null,
    pointerTarget: () => current,
    setCursor(cursor: string): void {
      renderer.domElement.style.cursor = cursor;
    },
    setEndoscope(on: boolean): void {
      endoscopeOn = on;
      insetFrame.hidden = !on;
    },
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
      move = { from: camera.position.clone(), fromTarget: controls.target.clone(), to: home, toTarget: homeTarget, start: performance.now() };
    },
    flyTo(point: readonly [number, number, number], distance: number): void {
      const target = new THREE.Vector3(...point);
      const direction = home.clone().sub(homeTarget).normalize();
      move = {
        from: camera.position.clone(),
        fromTarget: controls.target.clone(),
        to: target.clone().addScaledVector(direction, distance),
        toTarget: target,
        start: performance.now(),
      };
    },
    relabel(): void {
      renderer.domElement.setAttribute('aria-label', tr('view.aria'));
      insetLabel.textContent = tr('endoscope.label');
      anchors = labelAnchors();
      buildLabels();
    },
    dispose(): void {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', cancelMove);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      insetFrame.remove();
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
      camera.position.lerpVectors(move.from, move.to, t);
      controls.target.lerpVectors(move.fromTarget, move.toTarget, t);
      if (t >= 1) move = null;
    }
    controls.update();
    scene.setPulse(reducedMotion ? 0 : ((now - began) / 1000) * (api.beatsPerMinute() / 60));
    current = aim();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.render(three, camera);
    if (endoscopeOn) {
      const rect = insetRect();
      renderer.setScissorTest(true);
      renderer.setViewport(rect.x, rect.y, rect.size, rect.size);
      renderer.setScissor(rect.x, rect.y, rect.size, rect.size);
      renderer.clearDepth();
      renderer.render(three, endoscope);
      renderer.setScissorTest(false);
    }
    updateLabels(width, height);
  };
  frame = requestAnimationFrame(loop);
  return api;
}
