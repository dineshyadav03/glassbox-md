import { el, setClass, setText, svg } from './dom';
import type { DialView, GaugeView } from './hudModel';

const CENTRE = 60;
const RADIUS = 46;

/** Position on the dial for an angle (0 at the top, positive clockwise). */
export function dialPoint(angleDeg: number, radius: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180;
  return { x: CENTRE + radius * Math.sin(a), y: CENTRE - radius * Math.cos(a) };
}

/** SVG path for an arc of the dial from one angle to another (clockwise). */
export function dialArc(fromDeg: number, toDeg: number, radius: number): string {
  const a = dialPoint(fromDeg, radius);
  const b = dialPoint(toDeg, radius);
  const sweep = ((toDeg - fromDeg) % 360 + 360) % 360;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/** The tip-rotation dial: a needle for the tip, marks for the angles the learner needs, and the acceptance window. */
export function createDial(): { root: SVGSVGElement; title: HTMLElement; update(view: DialView | null): void } {
  const marks = svg('g', { class: 'dial-marks' });
  const targets = svg('g', { class: 'dial-targets' });
  const needle = svg('line', { x1: CENTRE, y1: CENTRE, x2: CENTRE, y2: CENTRE - RADIUS + 6, class: 'dial-needle' });
  const hub = svg('circle', { cx: CENTRE, cy: CENTRE, r: 3.5, class: 'dial-hub' });
  for (let a = 0; a < 360; a += 30) {
    const outer = dialPoint(a, RADIUS);
    const inner = dialPoint(a, RADIUS - (a % 90 === 0 ? 7 : 4));
    marks.append(svg('line', { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, class: 'dial-tick' }));
  }
  const root = svg('svg', { viewBox: '0 0 120 120', class: 'dial', role: 'img', 'aria-label': 'Tip rotation dial' }, [
    svg('circle', { cx: CENTRE, cy: CENTRE, r: RADIUS, class: 'dial-face' }),
    marks,
    targets,
    needle,
    hub,
  ]);
  const title = el('span', { className: 'dial-title' });
  let signature = '';

  return {
    root,
    title,
    update(view: DialView | null): void {
      root.style.display = view ? '' : 'none';
      title.style.display = view ? '' : 'none';
      if (!view) return;
      setText(title, view.title);
      needle.setAttribute('transform', `rotate(${view.angleDeg.toFixed(1)} ${CENTRE} ${CENTRE})`);
      const next = JSON.stringify([view.targets, view.windowDeg]);
      if (next === signature) return;
      signature = next;
      targets.replaceChildren();
      const wanted = view.targets.find((t) => t.wanted);
      if (wanted && view.windowDeg !== null) {
        targets.append(svg('path', { d: dialArc(wanted.angleDeg - view.windowDeg, wanted.angleDeg + view.windowDeg, RADIUS + 5), class: 'dial-window' }));
      }
      for (const t of view.targets) {
        const dot = dialPoint(t.angleDeg, RADIUS);
        const text = dialPoint(t.angleDeg, RADIUS - 15);
        targets.append(svg('circle', { cx: dot.x, cy: dot.y, r: t.wanted ? 4.5 : 3.2, class: t.wanted ? 'dial-target wanted' : 'dial-target' }));
        const label = svg('text', { x: text.x, y: text.y, class: 'dial-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
        label.textContent = t.label;
        targets.append(label);
      }
    },
  };
}

/** The inflation pressure gauge: a bar with the balloon's own marks, a needle, and the readout under it. */
export function createPressureGauge(): { root: HTMLElement; update(view: GaugeView): void } {
  const zones = el('div', { className: 'gauge-zones' });
  const needle = el('div', { className: 'gauge-needle' });
  const marks = el('div', { className: 'gauge-marks' });
  const bar = el('div', { className: 'gauge-bar', attrs: { role: 'img', 'aria-label': 'Inflation pressure gauge' } }, [zones, marks, needle]);
  const readout = el('p', { className: 'gauge-readout' });
  const state = el('p', { className: 'gauge-state' });
  const root = el('div', { className: 'gauge' }, [bar, readout, state]);
  let signature = '';

  const STATE_TEXT: Record<GaugeView['state'], string> = {
    'in-guide': 'In the guide: advance it over the wire to use it.',
    folded: 'Folded in the artery.',
    inflated: 'Inflated.',
    'over-rated': 'Above the rated pressure: risk of rupture.',
    ruptured: 'Ruptured. Withdraw it and load a fresh one.',
    deployed: 'Stent deployed.',
  };

  return {
    root,
    update(view: GaugeView): void {
      const pct = (atm: number): string => `${Math.min(100, (atm / view.max) * 100).toFixed(2)}%`;
      const next = `${view.max}|${view.nominal}|${view.rated}|${view.rupture}|${view.deployAt}`;
      if (next !== signature) {
        signature = next;
        zones.style.background = `linear-gradient(to right, #2e8b57 0 ${pct(view.nominal)}, #c9a227 ${pct(view.nominal)} ${pct(view.rated)}, #c0392b ${pct(view.rated)} 100%)`;
        marks.replaceChildren();
        const add = (atm: number, text: string): void => {
          const tick = el('span', { className: 'gauge-mark', text });
          tick.style.left = pct(atm);
          marks.append(tick);
        };
        add(view.nominal, `nominal ${view.nominal}`);
        add(view.rated, `rated ${view.rated}`);
        if (view.deployAt !== null) add(view.deployAt, `opens ${view.deployAt}`);
      }
      needle.style.left = pct(view.pressure);
      setText(readout, `${view.pressure.toFixed(1)} atm  ·  ${view.diameterMm.toFixed(2)} mm  ·  ${view.label}${view.runSeconds > 0 ? `  ·  up ${Math.round(view.runSeconds)} s` : ''}`);
      setText(state, STATE_TEXT[view.state]);
      setClass(root, 'danger', view.state === 'over-rated' || view.state === 'ruptured');
    },
  };
}
