/**
 * Anatomy labels: where each one sits and what it says. Built from the config's vessels, so a label always sits
 * on the structure it names after a config edit. (English only for now; M6 moves the text into the language files.)
 */
import { ANATOMY } from '../config/anatomy';
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
    { id: 'ica', text: 'Internal carotid artery', detail: 'The main artery that carries blood up to the brain on this side. The aneurysm arises from it.', position: along(vessels.ica, 0.35, [-5, 0, 0]) },
    { id: 'm1', text: 'M1', detail: 'The first segment of the middle cerebral artery, running outward along the sylvian fissure.', position: along(vessels.m1, 0.55, [0, 4, 0]) },
    { id: 'a1', text: 'A1', detail: 'The first segment of the anterior cerebral artery, running toward the midline.', position: along(vessels.a1, 0.6, [0, 4, 0]) },
    { id: 'pcom', text: 'PCom', detail: 'The posterior communicating artery. It leaves the carotid right beside the aneurysm and must stay open.', position: along(vessels.pcom, 0.85, [-5, -1, 0]) },
    { id: 'achoa', text: 'Anterior choroidal', detail: 'A small but important branch just beyond the aneurysm. A clip that narrows it can cause harm.', position: along(vessels.achoa, 0.9, [4, -3, 0]) },
    { id: 'optic', text: 'Optic nerve', detail: 'The nerve of sight. It lies beside the carotid and must be protected.', position: along(nerves.optic, 0.5, [-4, 4, 0]) },
    { id: 'oculomotor', text: 'Oculomotor nerve', detail: 'The third cranial nerve, which moves the eye and lifts the eyelid. It runs below the posterior communicating artery.', position: along(nerves.oculomotor, 0.5, [0, -4, 0]) },
    { id: 'aneurysm', text: 'Aneurysm', detail: 'A weak, ballooned part of the artery wall at the carotid and posterior communicating junction. It can rupture.', position: add(aneurysm.domeCentre, [6, -4, 0]), emphasis: true },
    { id: 'frontal', text: 'Frontal lobe', detail: 'Held up out of the way, so the surgeon can see the vessels beneath it.', position: [-20, 24, -10] },
    { id: 'temporal', text: 'Temporal lobe', detail: 'Held down out of the way, so the surgeon can see the vessels above it.', position: [-20, -26, -10] },
  ];
}
