/** The words for the field readout panel, as a pure function of the state (so the DOM code has nothing to get wrong). */
import { RULES } from '../config/rules';
import { t, type MessageKey } from '../i18n';
import type { FieldState } from '../procedure/field';

export interface Row {
  readonly label: string;
  readonly value: string;
  /** Draws the value in a warning colour. */
  readonly tone: 'normal' | 'warn' | 'bad' | 'good';
}

const pct = (v: number): number => Math.round(v * 100);

export function strainWord(stress: number): { text: string; tone: Row['tone'] } {
  if (stress >= RULES.ruptureStress) return { text: t('val.strain.ruptured'), tone: 'bad' };
  if (stress >= 0.6) return { text: t('val.strain.high'), tone: 'bad' };
  if (stress >= 0.25) return { text: t('val.strain.rising'), tone: 'warn' };
  return { text: t('val.strain.low'), tone: 'normal' };
}

/** A clip's variant, angle and depth as one phrase. */
export function clipSummary(setup: { variant: 'straight' | 'curved'; angleDeg: number; depth: number }): string {
  return t('val.clip', { variant: t(`variant.${setup.variant}` as MessageKey), angle: setup.angleDeg, depth: pct(setup.depth) });
}

export function fieldRows(state: FieldState): Row[] {
  const strain = strainWord(state.domeStress);
  const tempTone: Row['tone'] = state.tempClip.on ? (state.tempClip.seconds >= RULES.tempClipLongSeconds ? 'bad' : state.tempClip.seconds >= RULES.tempClipWarnSeconds ? 'warn' : 'normal') : 'normal';
  const retractionTone: Row['tone'] = state.retraction > 0 && state.retractionSeconds >= RULES.retractionWarnSeconds ? 'warn' : 'normal';
  const seconds = (s: number): number => Math.round(s);
  const temp = state.tempClip.on
    ? t('val.temp.on', { s: seconds(state.tempClip.seconds) })
    : state.tempClip.totalSeconds > 0
      ? t('val.temp.offSoFar', { s: seconds(state.tempClip.totalSeconds) })
      : t('val.temp.off');
  return [
    { label: t('row.membrane'), value: t('val.of', { n: state.cut.length, total: RULES.arachnoidOrder.length }), tone: state.cut.length === RULES.arachnoidOrder.length ? 'good' : 'normal' },
    { label: t('row.fissure'), value: state.retraction > 0 ? t('val.heldOpen', { pct: pct(state.retraction) }) : t('val.closed'), tone: retractionTone },
    { label: t('row.neck'), value: t('val.pct', { pct: pct(state.neckFreed) }), tone: state.neckFreed >= RULES.neckFreedForClip ? 'good' : 'normal' },
    { label: t('row.strain'), value: strain.text, tone: strain.tone },
    { label: t('row.bleeding'), value: String(state.oozes.length), tone: state.oozes.length > 0 ? 'warn' : 'normal' },
    { label: t('row.temp'), value: temp, tone: tempTone },
    { label: t('row.clip'), value: state.clip ? clipSummary(state.clip) : t('val.none'), tone: state.clip ? 'good' : 'normal' },
    { label: t('row.injuries'), value: String(state.injuries.length), tone: state.injuries.length > 0 ? 'bad' : 'normal' },
  ];
}
