/**
 * The WebGL viewer: renders an AnatomyScene with an orbit camera, runs the heartbeat, and draws the
 * anatomy labels as HTML on top. This is the only module that touches the renderer and the DOM;
 * the geometry and maths it uses are tested separately.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PHYSIOLOGY } from '../config/anatomy';
import type { LabelAnchor } from '../anatomy/labels';
import type { AnatomyScene } from './anatomyScene';
import { boxFramingDistance, cardiacPhase, easeInOut, framingDistance, isOnScreen, labelShownAt, ndcToPixels } from './framing';

export interface ViewerOptions {
  /** Called with the label under the pointer, or null when it leaves. */
  readonly onLabelHover?: (label: LabelAnchor | null) => void;
}

export interface Viewer {
  frameHeart(): void;
  frameRoute(): void;
  setLabelsVisible(visible: boolean): void;
  readonly labelsVisible: boolean;
  dispose(): void;
}

const FOV = 38;

/** Make a viewer inside `container`, or return null if the browser cannot provide WebGL. */
export function createViewer(container: HTMLElement, anatomy: AnatomyScene, options: ViewerOptions = {}): Viewer | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0b0f14, 1);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute(
    'aria-label',
    '3D view of the heart, coronary arteries, aorta and the arteries from the right wrist. Drag to orbit, scroll to zoom.',
  );
  renderer.domElement.style.display = 'block';
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(anatomy.root);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 4000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 8;
  controls.maxDistance = 1800;
  controls.zoomSpeed = 0.9;

  // --- labels ------------------------------------------------------------------------------
  const layer = document.createElement('div');
  layer.className = 'label-layer';
  container.append(layer);
  const elements = anatomy.labels.map((anchor) => {
    const node = document.createElement('span');
    node.className = anchor.emphasis ? 'anatomy-label emphasis' : 'anatomy-label';
    node.textContent = anchor.text;
    node.addEventListener('pointerenter', () => options.onLabelHover?.(anchor));
    node.addEventListener('pointerleave', () => options.onLabelHover?.(null));
    layer.append(node);
    return node;
  });
  let showLabels = true;
  const raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  const direction = new THREE.Vector3();

  const updateLabels = (width: number, height: number): void => {
    anatomy.root.updateMatrixWorld();
    anatomy.labels.forEach((anchor, i) => {
      const node = elements[i]!;
      if (!showLabels || !labelShownAt(anchor.scope, camera.position.distanceTo(controls.target))) {
        node.style.display = 'none';
        return;
      }
      scratch.set(anchor.position[0], anchor.position[1], anchor.position[2]);
      if (anchor.beats) scratch.applyMatrix4(anatomy.beating.matrixWorld);
      const world = scratch.clone();
      const ndc = world.clone().project(camera);
      if (!isOnScreen(ndc.x, ndc.y, ndc.z)) {
        node.style.display = 'none';
        return;
      }
      const { x, y } = ndcToPixels(ndc.x, ndc.y, width, height);
      node.style.display = 'block';
      node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -120%)`;
      // Dim a label whose point is hidden behind the heart.
      direction.copy(world).sub(camera.position);
      const distance = direction.length();
      raycaster.set(camera.position, direction.normalize());
      raycaster.far = distance - 2;
      const hit = raycaster.intersectObject(anatomy.heartMesh, false).length > 0;
      node.classList.toggle('behind', hit);
    });
  };

  // --- camera moves ---------------------------------------------------------------------------
  let move: { from: THREE.Vector3; fromTarget: THREE.Vector3; to: THREE.Vector3; toTarget: THREE.Vector3; start: number; seconds: number } | null =
    null;

  const aspect = (): number => Math.max(0.1, container.clientWidth / Math.max(1, container.clientHeight));

  const flyTo = (target: THREE.Box3, viewDirection: THREE.Vector3, padding: number): void => {
    // Pad the box so labels, which sit a little outside the anatomy, are not cut off at the edge.
    const box = target.clone().expandByScalar(padding);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const distance = boxFramingDistance(size.x / 2, size.y / 2, size.z / 2, FOV, aspect());
    move = {
      from: camera.position.clone(),
      fromTarget: controls.target.clone(),
      to: centre.clone().addScaledVector(viewDirection.clone().normalize(), distance),
      toTarget: centre.clone(),
      start: performance.now(),
      seconds: 0.7,
    };
  };

  const frameHeart = (): void => flyTo(anatomy.heartBounds, new THREE.Vector3(0.12, 0.1, 1), 14);
  const frameRoute = (): void => flyTo(anatomy.routeBounds, new THREE.Vector3(0.1, 0.05, 1), 80);

  // --- sizing -----------------------------------------------------------------------------------
  let width = 1;
  let height = 1;
  const resize = (): void => {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // Start framed on the heart, without an animation.
  {
    const sphere = anatomy.heartBounds.getBoundingSphere(new THREE.Sphere());
    camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(0.12, 0.1, 1).normalize(), framingDistance(sphere.radius, FOV, aspect()));
    controls.target.copy(sphere.center);
    controls.update();
  }

  // --- the loop ---------------------------------------------------------------------------------------
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const began = performance.now();
  let frame = 0;
  const loop = (now: number): void => {
    frame = requestAnimationFrame(loop);
    if (move) {
      const t = easeInOut((now - move.start) / (move.seconds * 1000));
      camera.position.lerpVectors(move.from, move.to, t);
      controls.target.lerpVectors(move.fromTarget, move.toTarget, t);
      if (t >= 1) move = null;
    }
    controls.update();
    anatomy.setBeatPhase(reducedMotion ? 0 : cardiacPhase((now - began) / 1000, PHYSIOLOGY.baseHr));
    renderer.render(scene, camera);
    updateLabels(width, height);
  };
  frame = requestAnimationFrame(loop);

  // A drag by the user cancels a camera move in progress.
  const cancelMove = (): void => {
    move = null;
  };
  renderer.domElement.addEventListener('pointerdown', cancelMove);
  renderer.domElement.addEventListener('wheel', cancelMove, { passive: true });

  return {
    frameHeart,
    frameRoute,
    setLabelsVisible(visible: boolean): void {
      showLabels = visible;
      if (!visible) for (const node of elements) node.style.display = 'none';
    },
    get labelsVisible(): boolean {
      return showLabels;
    },
    dispose(): void {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', cancelMove);
      renderer.domElement.removeEventListener('wheel', cancelMove);
      controls.dispose();
      anatomy.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      layer.remove();
    },
  };
}
