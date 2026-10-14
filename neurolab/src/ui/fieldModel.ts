/** The words for the field readout panel, as a pure function of the state (so the DOM code has nothing to get wrong). */
import { RULES } from '../config/rules';
import type { FieldState } from '../procedure/field';

export interface Row {
  readonly label: string;
  readonly value: string;
  /** Draws the value in a warning colour. */
  readonly tone: 'normal' | 'warn' | 'bad' | 'good';
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const seconds = (s: number): string => `${Math.round(s)} s`;

export function strainWord(stress: number): { text: string; tone: Row['tone'] } {
  if (stress >= RULES.ruptureStress) return { text: 'ruptured', tone: 'bad' };
  if (stress >= 0.6) return { text: 'high', tone: 'bad' };
  if (stress >= 0.25) return { text: 'rising', tone: 'warn' };
  return { text: 'low', tone: 'normal' };
}

export function fieldRows(state: FieldState): Row[] {
  const strain = strainWord(state.domeStress);
  const tempTone: Row['tone'] = state.tempClip.on ? (state.tempClip.seconds >= RULES.tempClipLongSeconds ? 'bad' : state.tempClip.seconds >= RULES.tempClipWarnSeconds ? 'warn' : 'normal') : 'normal';
  const retractionTone: Row['tone'] = state.retraction > 0 && state.retractionSeconds >= RULES.retractionWarnSeconds ? 'warn' : 'normal';
  const clip = state.clip ? `${state.clip.variant}, ${state.clip.angleDeg}°, depth ${pct(state.clip.depth)}` : 'none';
  return [
    { label: 'Membrane cut', value: `${state.cut.length} of ${RULES.arachnoidOrder.length}`, tone: state.cut.length === RULES.arachnoidOrder.length ? 'good' : 'normal' },
    { label: 'Fissure', value: state.retraction > 0 ? `held open ${pct(state.retraction)}` : 'closed', tone: retractionTone },
    { label: 'Neck freed', value: pct(state.neckFreed), tone: state.neckFreed >= RULES.neckFreedForClip ? 'good' : 'normal' },
    { label: 'Dome strain', value: strain.text, tone: strain.tone },
    { label: 'Bleeding points', value: String(state.oozes.length), tone: state.oozes.length > 0 ? 'warn' : 'normal' },
    {
      label: 'Temporary clip',
      value: state.tempClip.on ? `on, ${seconds(state.tempClip.seconds)}` : state.tempClip.totalSeconds > 0 ? `off (${seconds(state.tempClip.totalSeconds)} so far)` : 'off',
      tone: tempTone,
    },
    { label: 'Clip', value: clip, tone: state.clip ? 'good' : 'normal' },
    { label: 'Injuries', value: String(state.injuries.length), tone: state.injuries.length > 0 ? 'bad' : 'normal' },
  ];
}
