/**
 * Anatomy labels: where each one sits and what it says. Built from the config's vessels, so a label always sits
 * on the structure it names after a config edit.
 */
import { ANATOMY } from '../config/anatomy';
import { t, type MessageKey } from '../i18n';
import { aneurysmGeometry } from './aneurysm';
import { buildNerves, buildVessels } from './vessels';
import { add, type Vec3 } from './vec3';

type Config = typeof ANATOMY;

export interface LabelAnchor {
  readonly id: string;
  readonly text: string;
  /** One or two sentences, shown on hover. */
  readonly detail: string;
  readonly position: Vec3;
  /** The aneurysm's label is drawn more prominently. */
  readonly emphasis?: boolean;
}

export function labelAnchors(config: Config = ANATOMY): LabelAnchor[] {
  const vessels = buildVessels(config);
  const nerves = buildNerves(config);
  const along = (t: { path: { length: number; positionAt(d: number): Vec3 } }, fraction: number, lift: Vec3 = [0, 0, 0]): Vec3 =>
    add(t.path.positionAt(t.path.length * fraction), lift);
  const aneurysm = aneurysmGeometry(config);
  return [
    { id: 'ica', text: t('label.ica' as MessageKey), detail: t('label.ica.detail' as MessageKey), position: along(vessels.ica, 0.35, [-5, 0, 0]) },
    { id: 'm1', text: t('label.m1' as MessageKey), detail: t('label.m1.detail' as MessageKey), position: along(vessels.m1, 0.55, [0, 4, 0]) },
    { id: 'a1', text: t('label.a1' as MessageKey), detail: t('label.a1.detail' as MessageKey), position: along(vessels.a1, 0.6, [0, 4, 0]) },
    { id: 'pcom', text: t('label.pcom' as MessageKey), detail: t('label.pcom.detail' as MessageKey), position: along(vessels.pcom, 0.85, [-5, -1, 0]) },
    { id: 'achoa', text: t('label.achoa' as MessageKey), detail: t('label.achoa.detail' as MessageKey), position: along(vessels.achoa, 0.9, [4, -3, 0]) },
    { id: 'optic', text: t('label.optic' as MessageKey), detail: t('label.optic.detail' as MessageKey), position: along(nerves.optic, 0.5, [-4, 4, 0]) },
    { id: 'oculomotor', text: t('label.oculomotor' as MessageKey), detail: t('label.oculomotor.detail' as MessageKey), position: along(nerves.oculomotor, 0.5, [0, -4, 0]) },
    { id: 'aneurysm', text: t('label.aneurysm' as MessageKey), detail: t('label.aneurysm.detail' as MessageKey), position: add(aneurysm.domeCentre, [6, -4, 0]), emphasis: true },
    { id: 'frontal', text: t('label.frontal' as MessageKey), detail: t('label.frontal.detail' as MessageKey), position: [-20, 24, -10] },
    { id: 'temporal', text: t('label.temporal' as MessageKey), detail: t('label.temporal.detail' as MessageKey), position: [-20, -26, -10] },
  ];
}
