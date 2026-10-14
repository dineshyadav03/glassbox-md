import { t, type MessageKey } from '../i18n';
import { alarmFor, type Vitals } from '../physics/vitals';
import { ecgSampleMv } from '../physics/ecg';

const WIDTH = 280;
const HEIGHT = 70;
/** Sweep speed, pixels per second of case time. */
const SPEED = 70;
/** Pixels per millivolt. */
const SCALE = 38;
const BASELINE = HEIGHT * 0.72;
const GAP = 12;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export interface MonitorView {
  readonly vitals: Vitals;
  readonly eblMl: number;
  readonly seconds: number;
  readonly tempClipOn: boolean;
  readonly tempClipSeconds: number;
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The patient monitor: a sweeping ECG trace and the numbers. */
export function createMonitor(): { root: HTMLElement; update(view: MonitorView, dt: number): void; relabel(): void } {
  const canvas = node('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', t('mon.ecg'));
  const ctx = canvas.getContext('2d');
  const tiles: Record<string, HTMLElement> = {};
  const labels: { key: string; box: HTMLElement; label: HTMLElement }[] = [];
  const tile = (key: string): HTMLElement => {
    const value = node('span', 'tile-value', '--');
    tiles[key] = value;
    const box = node('div', 'tile');
    const label = node('span', 'tile-label');
    box.append(label, value);
    labels.push({ key, box, label });
    return box;
  };
  const heading = node('h2');
  const banner = node('p', 'monitor-banner');
  banner.setAttribute('role', 'status');
  const root = node('section', 'panel monitor');
  root.append(
    heading,
    canvas,
    (() => {
      const grid = node('div', 'tiles');
      grid.append(
        tile('hr'),
        tile('bp'),
        tile('spo2'),
        tile('mep'),
        tile('ebl'),
        tile('time'),
        tile('temp'),
      );
      return grid;
    })(),
    banner,
  );

  const keyFor: Record<string, string> = { hr: 'hr', bp: 'bp', spo2: 'spo2', mep: 'mep', ebl: 'blood', time: 'time', temp: 'temp' };
  const relabel = (): void => {
    heading.textContent = t('panel.monitor');
    canvas.setAttribute('aria-label', t('mon.ecg'));
    for (const item of labels) {
      const base = `mon.${keyFor[item.key]}`;
      item.label.textContent = t(base as MessageKey);
      item.box.title = t(`${base}.title` as MessageKey);
    }
  };
  relabel();

  let x = 0;
  let phase = 0;
  let previousY = BASELINE;
  let carry = 0;

  return {
    root,
    relabel,
    update(view, dt): void {
      const v = view.vitals;
      const alarm = alarmFor(v);
      tiles.hr!.textContent = String(Math.round(v.hr));
      tiles.bp!.textContent = `${Math.round(v.sbp)}/${Math.round(v.dbp)}`;
      tiles.spo2!.textContent = String(Math.round(v.spo2));
      tiles.mep!.textContent = `${Math.round(v.mep)}%`;
      tiles.ebl!.textContent = `${Math.round(view.eblMl)} ml`;
      tiles.time!.textContent = clock(view.seconds);
      tiles.temp!.textContent = view.tempClipOn ? clock(view.tempClipSeconds) : '--';
      banner.textContent = alarm?.text ?? '';
      root.classList.toggle('alarm', alarm !== null);
      if (!ctx) return;
      // One pixel at a time, so a slow frame still draws a continuous line.
      carry += dt * SPEED;
      const pixels = Math.floor(carry);
      carry -= pixels;
      ctx.strokeStyle = alarm ? '#ff6b5a' : '#4fe08a';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < pixels; i++) {
        phase += v.hr / 60 / SPEED;
        if (phase >= 1) phase -= 1;
        const y = BASELINE - ecgSampleMv(phase) * SCALE;
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
