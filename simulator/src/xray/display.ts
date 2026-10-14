/**
 * The X-ray screen: paints the shapes from `frame.ts` onto a canvas the way a fluoroscopy monitor shows
 * them (grey image, dark catheters and dye, quantum noise, circular collimator), and behaves like one:
 * the picture refreshes at the fluoro frame rate while the beam is on, the last image is held when it is
 * off, and the best-filled frame of each contrast run is kept as the angiogram.
 */
import { FLUORO } from '../config/anatomy';
import { currentCArm, type Simulation } from '../engine/simulation';
import { buildXrayFrame, fieldOfViewMm, xrayCentre, xrayMode, type Prim, type Shade } from './frame';
import type { Vec3 } from '../anatomy/vec3';

const SIZE = 640;

type HeldKind = 'none' | 'fluoro' | 'angiogram';

export interface XrayDisplay {
  readonly element: HTMLElement;
  /** Advance the picture. Call every frame; it redraws at the fluoro frame rate when the beam is on. */
  update(sim: Simulation, nowMs: number, heartRate: number, visible: boolean): void;
  dispose(): void;
}

const COLOUR: Readonly<Record<Shade, string>> = {
  tissue: '55,55,55',
  bone: '50,50,50',
  catheter: '25,25,25',
  wire: '10,10,10',
  marker: '0,0,0',
  stent: '15,15,15',
  balloon: '45,45,45',
  dye: '4,4,4',
};

/** How much to blur each kind of shape, in pixels, for the soft look of soft tissue and bone. */
const BLUR: Readonly<Partial<Record<Shade, number>>> = { tissue: 7, bone: 1.4 };

/** Shapes with translucent, overlapping segments are stroked without round caps so joints do not darken. */
const ROUND: ReadonlySet<Shade> = new Set<Shade>(['wire', 'marker']);

function paint(ctx: CanvasRenderingContext2D, prims: readonly Prim[]): void {
  ctx.lineJoin = 'round';
  let currentBlur = 0;
  // Connected segments of the same look are stroked as one path, so a long bone or catheter has no beads at its joints.
  let run: { shade: Shade; width: number; alpha: number; x: number; y: number } | null = null;
  const flush = (): void => {
    if (run) ctx.stroke();
    run = null;
  };
  for (const p of prims) {
    const blur = BLUR[p.shade] ?? 0;
    if (blur !== currentBlur) {
      flush();
      ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
      currentBlur = blur;
    }
    if (p.kind === 'polygon') {
      flush();
      ctx.fillStyle = `rgba(${COLOUR[p.shade]},${p.alpha})`;
      ctx.beginPath();
      for (let i = 0; i < p.points.length; i += 2) {
        if (i === 0) ctx.moveTo(p.points[0]!, p.points[1]!);
        else ctx.lineTo(p.points[i]!, p.points[i + 1]!);
      }
      ctx.closePath();
      ctx.fill();
      continue;
    }
    const joins =
      run !== null &&
      run.shade === p.shade &&
      Math.abs(run.width - p.width) < 0.01 &&
      Math.abs(run.alpha - p.alpha) < 0.005 &&
      Math.abs(run.x - p.x1) < 0.01 &&
      Math.abs(run.y - p.y1) < 0.01;
    if (!joins) {
      flush();
      ctx.strokeStyle = `rgba(${COLOUR[p.shade]},${p.alpha})`;
      ctx.lineWidth = p.width;
      ctx.lineCap = ROUND.has(p.shade) ? 'round' : 'butt';
      ctx.beginPath();
      ctx.moveTo(p.x1, p.y1);
    }
    ctx.lineTo(p.x2, p.y2);
    run = { shade: p.shade, width: p.width, alpha: p.alpha, x: p.x2, y: p.y2 };
  }
  flush();
  if (currentBlur !== 0) ctx.filter = 'none';
}

/**
 * Dye is drawn on its own layer, white where there is none. Each dye segment is stroked in a grey that
 * encodes its darkness, and overlapping segments keep the darker one (so joints and branch points do
 * not pile up). The layer is then multiplied onto the image, which darkens it by exactly that amount.
 */
function paintDye(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, prims: readonly Prim[]): void {
  if (prims.length === 0) return;
  const lc = layer.getContext('2d')!;
  lc.globalCompositeOperation = 'source-over';
  lc.fillStyle = '#fff';
  lc.fillRect(0, 0, layer.width, layer.height);
  lc.globalCompositeOperation = 'darken';
  lc.lineCap = 'round';
  lc.lineJoin = 'round';
  for (const p of prims) {
    if (p.kind !== 'line') continue;
    const v = Math.round(255 * (1 - Math.min(1, p.alpha)) + 4 * Math.min(1, p.alpha));
    lc.strokeStyle = `rgb(${v},${v},${v})`;
    lc.lineWidth = p.width;
    lc.beginPath();
    lc.moveTo(p.x1, p.y1);
    lc.lineTo(p.x2, p.y2);
    lc.stroke();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function noiseTile(): HTMLCanvasElement {
  const tile = makeCanvas(160, 160);
  const ctx = tile.getContext('2d')!;
  const image = ctx.createImageData(160, 160);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.random() * 255;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

export function createXrayDisplay(): XrayDisplay {
  const view = makeCanvas(SIZE, SIZE);
  view.className = 'xray-canvas';
  view.setAttribute('role', 'img');
  view.setAttribute('aria-label', 'X-ray fluoroscopy image');
  const frame = makeCanvas(SIZE, SIZE);
  const held = makeCanvas(SIZE, SIZE);
  const peak = makeCanvas(SIZE, SIZE);
  const dyeLayer = makeCanvas(SIZE, SIZE);
  const viewCtx = view.getContext('2d')!;
  const frameCtx = frame.getContext('2d')!;
  const heldCtx = held.getContext('2d')!;
  const peakCtx = peak.getContext('2d')!;
  const noise = noiseTile();
  const noisePattern = frameCtx.createPattern(noise, 'repeat');

  const element = document.createElement('div');
  element.className = 'xray';
  element.append(view);

  let heldKind: HeldKind = 'none';
  let lastDraw = -Infinity;
  let lastNow = 0;
  let centre: Vec3 | null = null;
  let field = 0;
  let peakAmount = 0;
  let sawRecordedRun = false;
  let composedKey = '';

  const drawImage = (sim: Simulation, heartRate: number): number => {
    const ctx = frameCtx;
    const gradient = ctx.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.1, SIZE / 2, SIZE / 2, SIZE * 0.7);
    gradient.addColorStop(0, '#d4d4d4');
    gradient.addColorStop(1, '#b9b9b9');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const image = buildXrayFrame(sim, { angles: sim.carmAngles, centre: centre!, fieldMm: field, size: SIZE, heartRate });
    paint(ctx, image.backdrop);
    paint(ctx, image.devices);
    paintDye(ctx, dyeLayer, image.dye);
    if (noisePattern) {
      ctx.save();
      const dx = Math.floor(Math.random() * 160);
      const dy = Math.floor(Math.random() * 160);
      ctx.translate(-dx, -dy);
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = noisePattern;
      ctx.fillRect(0, 0, SIZE + 160, SIZE + 160);
      ctx.restore();
    }
    return image.dyeAmount;
  };

  const compose = (sim: Simulation, live: boolean, cine: boolean): void => {
    const ctx = viewCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (live) ctx.drawImage(frame, 0, 0);
    else if (heldKind !== 'none') {
      ctx.drawImage(held, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(0, 0, SIZE, SIZE);
    }

    // The circular collimator.
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(0, 0, SIZE, SIZE);
    ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.49, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.49, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = '600 17px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(currentCArm(sim).label, 16, SIZE - 34);
    ctx.textAlign = 'right';
    ctx.fillText(`FOV ${Math.round(field)} mm`, SIZE - 16, SIZE - 34);
    ctx.textAlign = 'left';
    // The status sits at the top centre, inside the circle, clear of the view switch in the screen's corner.
    ctx.textAlign = 'center';
    if (live) {
      const word = cine ? 'CINE' : 'FLUORO';
      const width = ctx.measureText(word).width + 22;
      const left = SIZE / 2 - width / 2;
      ctx.fillStyle = '#ff5a4a';
      ctx.beginPath();
      ctx.arc(left + 7, 27, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff9d90';
      ctx.textAlign = 'left';
      ctx.fillText(word, left + 22, 18);
    } else {
      ctx.fillStyle = '#ffd37a';
      ctx.fillText(heldKind === 'angiogram' ? 'LAST ANGIOGRAM (held)' : heldKind === 'fluoro' ? 'LAST IMAGE HOLD' : '', SIZE / 2, 18);
    }
    ctx.textAlign = 'left';
    if (heldKind === 'none' && !live) {
      ctx.fillStyle = '#9aa7b4';
      ctx.font = '600 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Hold the fluoro pedal (Space) to see the X-ray image', SIZE / 2, SIZE / 2 - 10);
      ctx.textAlign = 'left';
    }
  };

  return {
    element,
    update(sim: Simulation, nowMs: number, heartRate: number, visible: boolean): void {
      const dt = Math.min(0.25, Math.max(0, (nowMs - lastNow) / 1000));
      lastNow = nowMs;
      const mode = xrayMode(sim);
      const targetCentre = xrayCentre(sim);
      const targetField = fieldOfViewMm(sim);
      if (!centre) {
        centre = targetCentre;
        field = targetField;
      } else {
        const k = 1 - Math.exp(-dt * 4);
        centre = [centre[0] + (targetCentre[0] - centre[0]) * k, centre[1] + (targetCentre[1] - centre[1]) * k, centre[2] + (targetCentre[2] - centre[2]) * k];
        field += (targetField - field) * k;
      }

      const cine = sim.injection !== null && sim.injection.recorded;
      if (cine) sawRecordedRun = true;
      let redrawn = false;
      if (mode.live && nowMs - lastDraw >= 1000 / FLUORO.frameRate) {
        lastDraw = nowMs;
        const amount = drawImage(sim, heartRate);
        heldCtx.clearRect(0, 0, SIZE, SIZE);
        heldCtx.drawImage(frame, 0, 0);
        heldKind = 'fluoro';
        if (cine && mode.showDye && amount > peakAmount) {
          peakAmount = amount;
          peakCtx.clearRect(0, 0, SIZE, SIZE);
          peakCtx.drawImage(frame, 0, 0);
        }
        redrawn = true;
      }

      // The run is over: keep its best-filled frame as the angiogram.
      if (!cine && sawRecordedRun) {
        sawRecordedRun = false;
        if (peakAmount > 0) {
          heldCtx.clearRect(0, 0, SIZE, SIZE);
          heldCtx.drawImage(peak, 0, 0);
          heldKind = 'angiogram';
        }
        peakAmount = 0;
      }

      if (visible) {
        // A live image is recomposed whenever a new frame was made; a held one only when something about it changed.
        const key = `${mode.live}|${cine}|${heldKind}|${currentCArm(sim).label}|${Math.round(field)}`;
        if (redrawn || key !== composedKey) {
          compose(sim, mode.live, cine);
          composedKey = key;
        }
      } else {
        composedKey = '';
      }
    },
    dispose(): void {
      element.remove();
    },
  };
}
