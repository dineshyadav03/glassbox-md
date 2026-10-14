import { ecgSampleMv } from '../physics/ecg';
import { el, setClass, setText } from './dom';
import type { MonitorView } from './hudModel';

const WIDTH = 300;
const HEIGHT = 92;
/** Sweep speed, pixels per second of case time. */
const SPEED = 70;
/** Pixels per millivolt. */
const SCALE = 42;
const BASELINE = HEIGHT * 0.62;
const GAP = 14;

/** The patient monitor: a sweeping V2 ECG trace and the numbers. */
export function createMonitor(): { root: HTMLElement; update(view: MonitorView, dt: number): void } {
  const canvas = el('canvas', { attrs: { width: String(WIDTH), height: String(HEIGHT), role: 'img', 'aria-label': 'Electrocardiogram trace, lead V2' } });
  const ctx = canvas.getContext('2d');
  const tile = (label: string, title: string): { box: HTMLElement; value: HTMLElement } => {
    const value = el('span', { className: 'tile-value', text: '--' });
    return { box: el('div', { className: 'tile', title }, [el('span', { className: 'tile-label', text: label }), value]), value };
  };
  const hr = tile('HR', 'Heart rate, beats per minute');
  const bp = tile('BP', 'Arterial blood pressure, mmHg');
  const spo2 = tile('SpO2', 'Oxygen saturation, %');
  const act = tile('ACT', 'Activated clotting time, seconds');
  const st = tile('ST', 'ST elevation in lead V2, mm');
  const banner = el('p', { className: 'monitor-banner', attrs: { role: 'status' } });
  const root = el('section', { className: 'panel monitor' }, [
    el('h2', { className: 'panel-title', text: 'Monitor · ECG lead V2' }),
    canvas,
    el('div', { className: 'tiles' }, [hr.box, bp.box, spo2.box, act.box, st.box]),
    banner,
  ]);

  let x = 0;
  let phase = 0;
  let beat = 0;
  let previousY = BASELINE;
  let carry = 0;

  const colourFor = (view: MonitorView): string => (view.alarm ? '#ff6b5a' : view.ischaemia > 0.35 ? '#f0b64a' : '#4fe08a');

  return {
    root,
    update(view: MonitorView, dt: number): void {
      setText(hr.value, String(view.heartRate));
      setText(bp.value, view.bp);
      setText(spo2.value, String(view.spo2));
      setText(act.value, String(view.actSeconds));
      setText(st.value, view.stMm.toFixed(1));
      setText(banner, view.message ?? '');
      setClass(banner, 'alarm', view.alarm);
      setClass(root, 'alarm', view.alarm);
      if (!ctx) return;

      // One pixel at a time, so a slow frame still draws a continuous line.
      carry += dt * SPEED;
      const pixels = Math.floor(carry);
      carry -= pixels;
      ctx.strokeStyle = colourFor(view);
      ctx.lineWidth = 1.6;
      for (let i = 0; i < pixels; i++) {
        phase += view.heartRate / 60 / SPEED;
        if (phase >= 1) {
          phase -= 1;
          beat += 1;
        }
        const pvcBeat = view.pvc && beat % 3 === 0;
        const mv = ecgSampleMv(phase, { stMm: view.stMm, pvc: pvcBeat });
        const y = BASELINE - mv * SCALE;
        const nextX = (x + 1) % WIDTH;
        ctx.clearRect(nextX, 0, GAP, HEIGHT);
        if (nextX < x) ctx.clearRect(0, 0, GAP, HEIGHT);
        ctx.beginPath();
        if (nextX > x) {
          ctx.moveTo(x, previousY);
          ctx.lineTo(nextX, y);
        }
        ctx.stroke();
        x = nextX;
        previousY = y;
      }
    },
  };
}
