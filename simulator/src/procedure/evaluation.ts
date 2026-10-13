/**
 * The scored debrief. `buildDebrief` is a pure function of a summary of the case, so the same
 * rules score a learner's run, the demo autopilot, and a deliberately bad case in tests.
 *
 * The thresholds and weights are teaching choices. They are not clinical standards or targets.
 */
import { DEBRIEF } from '../config/anatomy';

export type Timi = 0 | 1 | 2 | 3;

export interface ProcedureSummary {
  /** All six stages were finished (not ended early). */
  readonly completed: boolean;
  /** Worst diameter stenosis left across the lesion, as a fraction; null if nothing was treated. */
  readonly residualStenosis: number | null;
  readonly finalTimi: Timi | null;
  /** First stent's expanded diameter over the reference diameter at the lesion; null if no stent. */
  readonly stentDiameterRatio: number | null;
  /** Mm the stent reaches past each end of the lesion; negative means it stops short. Null if no stent. */
  readonly proximalMarginMm: number | null;
  readonly distalMarginMm: number | null;
  readonly stentsDeployed: number;
  readonly heparin: 'before-wire' | 'late' | 'none';
  readonly predilated: boolean;
  readonly qcaUsed: boolean;
  readonly dissection: 'none' | 'sealed' | 'unsealed';
  readonly wireForcingSeconds: number;
  readonly balloonRuptures: number;
  readonly longestInflationS: number;
  readonly contrastMl: number;
  readonly fluoroSeconds: number;
  /** Distinct projections used for injections after the stent. */
  readonly finalViews: number;
}

export type Status = 'ok' | 'warn' | 'bad';
export type Grade = 'Excellent' | 'Good' | 'Acceptable' | 'Needs work' | 'Incomplete';

export interface DebriefItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly status: Status;
  readonly points: number;
  readonly maxPoints: number;
  /** One or two sentences on why this matters. */
  readonly teaching: string;
}

export interface Debrief {
  /** 0 to 100. */
  readonly score: number;
  readonly grade: Grade;
  readonly headline: string;
  readonly items: readonly DebriefItem[];
  /** Safety-critical findings that cap the grade at "Needs work" whatever the score. */
  readonly cappedBy: readonly string[];
}

function points(status: Status, max: number): number {
  return status === 'ok' ? max : status === 'warn' ? Math.round(max / 2) : 0;
}

function item(id: string, label: string, value: string, status: Status, max: number, teaching: string): DebriefItem {
  return { id, label, value, status, points: points(status, max), maxPoints: max, teaching };
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function gradeFromScore(score: number): Exclude<Grade, 'Incomplete'> {
  if (score >= DEBRIEF.gradeExcellentAt) return 'Excellent';
  if (score >= DEBRIEF.gradeGoodAt) return 'Good';
  if (score >= DEBRIEF.gradeAcceptableAt) return 'Acceptable';
  return 'Needs work';
}

export function buildDebrief(summary: ProcedureSummary): Debrief {
  const items: DebriefItem[] = [];

  // Residual stenosis
  {
    const r = summary.residualStenosis;
    const status: Status = r === null ? 'bad' : r <= DEBRIEF.residualStenosisOk ? 'ok' : r <= DEBRIEF.residualStenosisWarn ? 'warn' : 'bad';
    items.push(item('residual', 'Residual stenosis', r === null ? 'not treated' : pct(r), status, 12,
      'A good result leaves little narrowing behind. Under-expansion is a known reason a stented segment goes wrong later.'));
  }

  // Final flow
  {
    const t = summary.finalTimi;
    const status: Status = t === null ? 'bad' : t === 3 ? 'ok' : t === 2 ? 'warn' : 'bad';
    items.push(item('timi', 'Final flow (TIMI grade)', t === null ? 'not assessed' : `TIMI ${t}`, status, 12,
      'The TIMI grade describes how briskly dye fills the artery beyond the treated segment. Grade 3 is normal filling; slow filling after treatment points to a problem such as a dissection.'));
  }

  // Stent size against the vessel
  {
    const r = summary.stentDiameterRatio;
    let status: Status = 'bad';
    if (r !== null) {
      const [okLow, okHigh] = DEBRIEF.stentRatioOk;
      const [warnLow, warnHigh] = DEBRIEF.stentRatioWarn;
      if (r >= okLow && r <= okHigh) status = 'ok';
      else if (r >= warnLow && r <= warnHigh) status = 'warn';
    }
    items.push(item('stent-size', 'Stent size against the vessel', r === null ? 'no stent' : `${r.toFixed(2)} x reference`, status, 8,
      'A stent is sized to the vessel\'s reference diameter. Much smaller risks under-expansion; much larger, beyond about 1.2 times, can tear the wall.'));
  }

  // Coverage of the lesion
  let geographicMiss = false;
  {
    const { proximalMarginMm: p, distalMarginMm: d } = summary;
    let status: Status = 'bad';
    let value = 'no stent';
    if (p !== null && d !== null) {
      value = `${p.toFixed(1)} mm proximal, ${d.toFixed(1)} mm distal`;
      if (p < 0 || d < 0) {
        geographicMiss = true;
        value += ' (geographic miss)';
      } else if (p >= DEBRIEF.coverageMarginOkMm && d >= DEBRIEF.coverageMarginOkMm) status = 'ok';
      else status = 'warn';
    }
    items.push(item('coverage', 'Lesion coverage', value, status, 10,
      'The stent should reach a little past both ends of the lesion. Stopping short leaves diseased vessel at the edge, called a geographic miss.'));
  }

  // Extra stents
  {
    const n = summary.stentsDeployed;
    const status: Status = n <= 1 ? 'ok' : n === 2 ? 'warn' : 'bad';
    items.push(item('extra-stents', 'Extra stents', String(Math.max(0, n - 1)), status, 4,
      'Each extra stent adds metal to the vessel. Extra stents are usually a bailout for a complication or a sizing error.'));
  }

  // Heparin
  {
    const h = summary.heparin;
    const status: Status = h === 'before-wire' ? 'ok' : h === 'late' ? 'warn' : 'bad';
    const value = h === 'before-wire' ? 'before the wire' : h === 'late' ? 'after the wire was in' : 'not given';
    items.push(item('heparin', 'Heparin', value, status, 6,
      'Heparin helps stop clots forming on wires and catheters inside the artery, so it is given before the wire enters the coronary.'));
  }

  // Pre-dilation
  items.push(item('predilation', 'Pre-dilation', summary.predilated ? 'done' : 'skipped', summary.predilated ? 'ok' : 'bad', 4,
    'Pre-dilating opens a very tight lesion so the stent can cross and expand. In this simulator it is a required step.'));

  // QCA
  items.push(item('qca', 'Vessel measured (QCA)', summary.qcaUsed ? 'yes' : 'no', summary.qcaUsed ? 'ok' : 'warn', 4,
    'Quantitative coronary analysis measures the vessel on the angiogram so the stent is sized from numbers, not by eye.'));

  // Dissection
  {
    const d = summary.dissection;
    const status: Status = d === 'none' ? 'ok' : d === 'sealed' ? 'warn' : 'bad';
    const value = d === 'none' ? 'none' : d === 'sealed' ? 'occurred, sealed by the stent' : 'occurred, not sealed';
    items.push(item('dissection', 'Dissection', value, status, 12,
      'A dissection is a tear in the vessel wall. Forcing the wire or over-sizing a balloon or stent causes one; a stent that covers it can seal it, while one that does not leaves flow reduced.'));
  }

  // Wire forcing
  {
    const s = summary.wireForcingSeconds;
    const status: Status = s <= DEBRIEF.forcingOkSeconds ? 'ok' : s <= DEBRIEF.forcingWarnSeconds ? 'warn' : 'bad';
    items.push(item('forcing', 'Wire forcing', s <= DEBRIEF.forcingOkSeconds ? 'none' : `${s.toFixed(1)} s`, status, 6,
      'A buckling wire is being pushed too hard against resistance. Advancing slowly, and spinning the wire, is gentler and lowers the chance of a tear.'));
  }

  // Rupture
  items.push(item('rupture', 'Balloon rupture', summary.balloonRuptures === 0 ? 'none' : String(summary.balloonRuptures),
    summary.balloonRuptures === 0 ? 'ok' : 'bad', 6,
    'Every balloon has a rated burst pressure. Going well beyond it risks rupture and injury to the vessel.'));

  // Longest inflation
  {
    const s = summary.longestInflationS;
    const status: Status = s <= DEBRIEF.longestInflationOkS ? 'ok' : s <= DEBRIEF.longestInflationWarnS ? 'warn' : 'bad';
    items.push(item('inflation', 'Longest inflation', `${Math.round(s)} s`, status, 4,
      'While the balloon is up no blood passes it, so the heart muscle beyond it is starved. Keep inflations short and watch the monitor.'));
  }

  // Contrast
  {
    const ml = summary.contrastMl;
    const status: Status = ml <= DEBRIEF.contrastOkMl ? 'ok' : ml <= DEBRIEF.contrastWarnMl ? 'warn' : 'bad';
    items.push(item('contrast', 'Contrast used', `${Math.round(ml)} ml`, status, 4,
      'Contrast dye can strain the kidneys. Use only as many injections as the decisions need.'));
  }

  // Fluoroscopy
  {
    const minutes = summary.fluoroSeconds / 60;
    const status: Status = minutes <= DEBRIEF.fluoroOkMinutes ? 'ok' : minutes <= DEBRIEF.fluoroWarnMinutes ? 'warn' : 'bad';
    items.push(item('fluoro', 'Fluoroscopy time', `${minutes.toFixed(1)} min`, status, 4,
      'X-ray exposure adds up for the patient and the team. Use the pedal in short taps rather than holding it down.'));
  }

  // Final views
  {
    const v = summary.finalViews;
    const status: Status = v >= DEBRIEF.minFinalViews ? 'ok' : v === 1 ? 'warn' : 'bad';
    items.push(item('views', 'Final views', `${v} projection${v === 1 ? '' : 's'}`, status, 4,
      'Looking from two different angles avoids missing a problem hidden behind overlapping vessels.'));
  }

  const score = items.reduce((sum, i) => sum + i.points, 0);

  const cappedBy: string[] = [];
  if (summary.dissection === 'unsealed') cappedBy.push('unsealed dissection');
  if (summary.balloonRuptures > 0) cappedBy.push('balloon rupture');
  if (geographicMiss) cappedBy.push('geographic miss');

  let grade: Grade;
  if (!summary.completed) grade = 'Incomplete';
  else grade = cappedBy.length > 0 ? 'Needs work' : gradeFromScore(score);

  return { score, grade, headline: headlineFor(grade, cappedBy), items, cappedBy };
}

function headlineFor(grade: Grade, cappedBy: readonly string[]): string {
  switch (grade) {
    case 'Excellent':
      return 'Excellent: a well-sized, fully covered stent, brisk flow and a clean procedure.';
    case 'Good':
      return 'Good: a sound result with a few things to tidy up.';
    case 'Acceptable':
      return 'Acceptable: the artery is treated, but several steps need work.';
    case 'Needs work':
      return cappedBy.length > 0
        ? `Needs work: ${cappedBy.join(' and ')} held the grade down, whatever the rest of the score.`
        : 'Needs work: the result and the technique both have problems to review.';
    case 'Incomplete':
      return 'Incomplete: the case was ended before all six stages were finished.';
  }
}
