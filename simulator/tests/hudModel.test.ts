import { describe, expect, it } from 'vitest';
import { createSimulation } from '../src/engine/simulation';
import {
  canChooseSize,
  carmReadout,
  coverageReadout,
  dialView,
  gaugeView,
  monitorView,
  stageList,
  toastView,
  TOAST_SECONDS,
  usageReadout,
  positionReadout,
  pressureAdvice,
  qcaReadout,
  sizeOptions,
  stageView,
  timeString,
  toolButtons,
} from '../src/ui/hudModel';
import { Player, playGoodCase } from './helpers/player';

describe('toolButtons', () => {
  it('lists the seven tools in key order, with kinds', () => {
    const buttons = toolButtons(createSimulation());
    expect(buttons.map((b) => `${b.key}:${b.id}`)).toEqual(['1:guide', '2:wire', '3:balloon', '4:stent', '5:contrast', '6:fluoro', '7:measure']);
    expect(buttons.map((b) => b.kind)).toEqual(['select', 'select', 'select', 'select', 'action', 'hold', 'action']);
  });

  it('starts with only the guide and the fluoro pedal available, the rest locked with a reason, and the guide active', () => {
    const buttons = toolButtons(createSimulation());
    expect(buttons.filter((b) => b.available).map((b) => b.id)).toEqual(['guide', 'fluoro']);
    for (const b of buttons.filter((x) => !x.available)) expect(b.reason!.length).toBeGreaterThan(10);
    expect(buttons.filter((b) => b.active).map((b) => b.id)).toEqual(['guide']);
  });

  it('unlocks tools as the case goes on', () => {
    const p = playGoodCase({ stopAfterWire: true });
    const ids = toolButtons(p.sim).filter((b) => b.available).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['guide', 'wire', 'balloon', 'contrast', 'fluoro', 'measure']));
    expect(ids).not.toContain('stent');
  });
});

describe('stageView', () => {
  it('starts on step 1 with every task undone and the first one marked next', () => {
    const v = stageView(createSimulation());
    expect(v.number).toBe(1);
    expect(v.total).toBe(6);
    expect(v.title).toMatch(/guide/i);
    expect(v.tasks.every((t) => !t.done)).toBe(true);
    expect(v.tasks.filter((t) => t.next)).toHaveLength(1);
    expect(v.tasks[0]!.next).toBe(true);
    expect(v.overall).toBe(0);
    expect(v.why.length).toBeGreaterThan(20);
    expect(v.finished).toBe(false);
  });

  it('moves the "next" marker and the progress as tasks are done', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 300);
    const v = stageView(p.sim);
    expect(v.tasks[0]!.done).toBe(true);
    expect(v.tasks[1]!.next).toBe(true);
    expect(v.overall).toBeGreaterThan(0);
  });

  it('reports the finished case', () => {
    const v = stageView(playGoodCase().sim);
    expect(v.finished).toBe(true);
    expect(v.number).toBe(7);
    expect(v.overall).toBe(1);
  });
});

describe('monitorView', () => {
  it('shows the resting vitals at the start', () => {
    const v = monitorView(createSimulation());
    expect(v).toMatchObject({ heartRate: 72, bp: '128/76', spo2: 98, actSeconds: 128, stMm: 0, pvc: false, alarm: false, message: null });
  });

  it('shows ST rising and a message while the LAD is blocked', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => (s.balloon.centreS ?? 0) >= 48, 30).until({ inflate: true }, (s) => s.balloon.pressure >= 10, 20).wait(25);
    const v = monitorView(p.sim);
    expect(v.stMm).toBeGreaterThan(1);
    expect(v.message).toMatch(/chest pain|unstable/i);
    expect(v.ischaemia).toBeGreaterThan(0.3);
  });
});

describe('dialView', () => {
  it('shows the cusp targets for the guide, with the left cusp wanted', () => {
    const v = dialView(createSimulation())!;
    expect(v.title).toBe('Guide tip');
    expect(v.targets.find((t) => t.wanted)!.label).toBe('Left cusp');
    expect(v.windowDeg).toBe(25);
    expect(v.angleDeg).toBe(0);
  });

  it('shows the branch targets for the wire as it nears a bifurcation, and none when far from one', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'wire' }).hold({ advance: -1 }, 100);
    p.until({ advance: -1 }, (s) => !s.wire.outOfGuide, 60);
    const idle = dialView(p.sim)!;
    expect(idle.targets).toEqual([]);
    const q = new Player().hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= 829.9);
    q.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram().do({ type: 'heparin' }).do({ type: 'select-tool', tool: 'wire' });
    q.until({ advance: 1, fine: true }, (s) => s.wire.outOfGuide && s.wire.s >= 5, 30);
    const near = dialView(q.sim)!;
    expect(near.targets.map((t) => t.label).sort()).toEqual(['LAD', 'LCx']);
    expect(near.targets.find((t) => t.wanted)!.label).toBe('LAD');
  });

  it('has no dial for the catheters', () => {
    expect(dialView(playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' }).sim)).toBeNull();
  });
});

describe('readouts', () => {
  it('describes where the guide is', () => {
    expect(positionReadout(createSimulation())).toMatch(/radial/);
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 400);
    expect(positionReadout(p.sim)).toMatch(/brachial/);
  });

  it('describes the wire and catheters', () => {
    const p = playGoodCase({ stopAfterWire: true });
    expect(positionReadout(p.do({ type: 'select-tool', tool: 'wire' }).sim)).toMatch(/LAD/);
    p.do({ type: 'select-tool', tool: 'balloon' });
    expect(positionReadout(p.sim)).toMatch(/in the guide/);
    p.hold({ advance: 1 }, 1);
    expect(positionReadout(p.sim)).toMatch(/along the LAD/);
  });

  it('reads the measurement once it has been taken, and the stent coverage', () => {
    expect(qcaReadout(createSimulation())).toBeNull();
    const p = playGoodCase({ stopAfterWire: true });
    expect(qcaReadout(p.sim)).toMatch(/2\.97 mm, MLD 0\.29 mm, lesion 14 mm, 90% stenosis/);
    expect(coverageReadout(p.sim)).toBeNull();
    const done = playGoodCase();
    expect(coverageReadout(done.sim)).toMatch(/Covers the lesion/);
  });

  it('names the C-arm projection and formats the case clock', () => {
    expect(carmReadout(createSimulation())).toMatch(/RAO/);
    expect(timeString(0)).toBe('0:00');
    expect(timeString(75.9)).toBe('1:15');
    expect(timeString(-5)).toBe('0:00');
  });
});

describe('gaugeView', () => {
  it('shows a catheter in the guide, then folded in the artery, then inflated and past its rating', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    expect(gaugeView(p.sim.balloon).state).toBe('in-guide');
    p.until({ advance: 1 }, (s) => (s.balloon.centreS ?? 0) >= 40, 20);
    expect(gaugeView(p.sim.balloon).state).toBe('folded');
    p.until({ inflate: true }, (s) => s.balloon.pressure >= 8, 20);
    expect(gaugeView(p.sim.balloon).state).toBe('inflated');
    p.until({ inflate: true }, (s) => s.balloon.pressure > 14.2, 20);
    const g = gaugeView(p.sim.balloon);
    expect(g.state).toBe('over-rated');
    expect(g.runSeconds).toBeGreaterThan(0);
    expect(g.diameterMm).toBeGreaterThan(2.5);
    p.until({ inflate: true }, (s) => s.balloon.ruptured, 20);
    expect(gaugeView(p.sim.balloon).state).toBe('ruptured');
  });

  it('puts the scale above the rupture pressure and gives the stent a deployment mark', () => {
    const sim = createSimulation();
    const balloon = gaugeView(sim.balloon);
    expect(balloon.max).toBeGreaterThan(balloon.rupture);
    expect(balloon.deployAt).toBeNull();
    expect(gaugeView(sim.stent).deployAt).toBe(6);
    expect(gaugeView(sim.stent).rated).toBe(16);
  });
});

describe('sizes', () => {
  it('offers the stocked sizes', () => {
    expect(sizeOptions('balloon').diameters).toEqual([2.0, 2.5, 3.0, 3.5]);
    expect(sizeOptions('stent').lengths).toEqual([12, 15, 18, 23, 28]);
  });

  it('allows a size change only while the catheter is in the guide and unspent', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    expect(canChooseSize(p.sim.balloon)).toBe(true);
    p.hold({ advance: 1 }, 1);
    expect(canChooseSize(p.sim.balloon)).toBe(false);
  });

  it('gives pressure advice for the balloon and the stent, and none for the guide', () => {
    const p = playGoodCase({ stopAfterWire: true });
    p.do({ type: 'select-tool', tool: 'balloon' });
    expect(pressureAdvice(p.sim)).toMatch(/6 atm/);
    p.do({ type: 'select-tool', tool: 'wire' });
    expect(pressureAdvice(p.sim)).toBe('');
  });
});

describe('stageList', () => {
  it('lists all six steps with the current one marked and no times yet', () => {
    const rows = stageList(createSimulation());
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.filter((r) => r.current).map((r) => r.number)).toEqual([1]);
    expect(rows.every((r) => !r.done && r.time === '')).toBe(true);
  });

  it('records when each step was finished, in order, and none is current at the end', () => {
    const rows = stageList(playGoodCase().sim);
    expect(rows.every((r) => r.done && /^\d+:\d\d$/.test(r.time))).toBe(true);
    expect(rows.some((r) => r.current)).toBe(false);
    const seconds = rows.map((r) => Number(r.time.split(':')[0]) * 60 + Number(r.time.split(':')[1]));
    for (let i = 1; i < seconds.length; i++) expect(seconds[i]!).toBeGreaterThanOrEqual(seconds[i - 1]!);
  });
});

describe('toastView', () => {
  it('shows the newest message while it is fresh and then lets it go', () => {
    const fresh = createSimulation();
    expect(toastView(fresh)?.text).toMatch(/Case start/);
    const stale = new Player().wait(TOAST_SECONDS + 1);
    expect(toastView(stale.sim)).toBeNull();
  });

  it('carries the message level', () => {
    const p = new Player().do({ type: 'select-tool', tool: 'wire' });
    expect(toastView(p.sim)?.level).toBe('warn');
  });
});

describe('usageReadout', () => {
  it('counts fluoroscopy time while the pedal is down and contrast as it is used', () => {
    expect(usageReadout(createSimulation())).toEqual({ fluoro: '0:00', contrast: '0 ml' });
    const p = playGoodCase({ stopAfterWire: true });
    expect(usageReadout(p.sim).contrast).toBe('8 ml');
    expect(usageReadout(p.sim).fluoro).toMatch(/^0:0\d$/);
  });
});
