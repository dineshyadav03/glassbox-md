/**
 * Anatomy labels: where each one sits in 3D and what it says. Pure data built from the config, so the
 * numbers in a tooltip can never disagree with the rules. Positions are in the frame of the group they
 * belong to (`beats: true` means the beating heart's group; false means fixed world space).
 */
import { AORTA_ENTRY_S, ELBOW_S, LESION, ROUTE_SEGMENTS, VESSELS, type VesselId } from '../config/anatomy';
import { AORTIC_ROOT, anatomyPaths, routePosition, vesselPosition } from './centrelines';
import { add, normalize, scale, type Vec3 } from './vec3';

export interface LabelAnchor {
  readonly id: string;
  readonly text: string;
  /** One or two sentences shown when the label is hovered. */
  readonly detail: string;
  readonly position: Vec3;
  readonly beats: boolean;
  /** 'heart' labels only show when zoomed in close; 'body' labels (the route, the aorta) show at any zoom. */
  readonly scope: 'heart' | 'body';
  /** The target lesion's label is drawn more prominently. */
  readonly emphasis?: boolean;
}

/** Nudge a point outward from the heart's centre so a label does not sit on the vessel it names. */
function outward(p: Vec3, mm: number): Vec3 {
  return add(p, scale(normalize(p), mm));
}

const mm = (n: number): string => `${Math.round(n)} mm`;

function vesselLabel(id: VesselId, at: number, detail: string): LabelAnchor {
  const spec = VESSELS[id];
  return {
    id: `vessel-${id}`,
    text: id === 'LM' ? 'Left main' : id,
    detail: `${spec.label}. ${mm(spec.length)} long in this model, ${spec.diameterProximal} mm wide at the start and ${spec.diameterDistal} mm at the end. ${detail}`,
    position: outward(vesselPosition(id, at), 7),
    beats: true,
    scope: 'heart',
  };
}

function routeLabel(id: (typeof ROUTE_SEGMENTS)[number]['id'], s: number, side: Vec3): LabelAnchor {
  const seg = ROUTE_SEGMENTS.find((x) => x.id === id)!;
  return {
    id: `route-${id}`,
    text: seg.label,
    detail: `${mm(seg.length)} of the ${mm(ROUTE_SEGMENTS.reduce((sum, x) => sum + x.length, 0))} route from the wrist to the aortic root.`,
    position: add(routePosition(s), side),
    beats: false,
    scope: 'body',
  };
}

/** Every label in the anatomy preview. */
export function labelAnchors(): LabelAnchor[] {
  const lesionPoint = vesselPosition(LESION.vessel, LESION.centreS);
  const { aorta } = anatomyPaths();
  const labels: LabelAnchor[] = [
    vesselLabel('LM', 6, 'It divides into the LAD and the circumflex.'),
    vesselLabel('LAD', 90, 'Runs down the front of the heart toward the apex. This is the vessel being treated.'),
    vesselLabel('LCx', 40, 'Runs around the left side of the heart, in the groove between atrium and ventricle.'),
    vesselLabel('D1', 30, 'The first diagonal branch of the LAD, which leaves it before the blockage.'),
    vesselLabel('D2', 25, 'The second diagonal branch of the LAD, which leaves it beyond the blockage.'),
    vesselLabel('RCA', 60, 'Supplies the right side and the underside of the heart. Not treated in this case.'),
    {
      id: 'lesion',
      text: `${Math.round(LESION.diameterStenosis * 100)}% lesion`,
      detail: `The blockage to treat: ${mm(LESION.length)} long in the mid-LAD, narrowing the vessel by ${Math.round(LESION.diameterStenosis * 100)}% of its diameter. It lies between the two diagonal branches.`,
      position: outward(lesionPoint, 14),
      beats: true,
      scope: 'heart',
      emphasis: true,
    },
    {
      id: 'aorta',
      text: 'Aorta',
      detail: 'The aortic arch and ascending aorta. The guide catheter reaches the aortic root from the brachiocephalic trunk.',
      position: add(aorta.positionAt(aorta.length * 0.42), [34, -6, -4]),
      beats: false,
      scope: 'body',
    },
    {
      id: 'aortic-root',
      text: 'Aortic root',
      detail: 'Where the guide catheter ends its journey, and where both coronary arteries arise.',
      position: add(AORTIC_ROOT, [-26, -12, 6]),
      beats: false,
      scope: 'heart',
    },
    routeLabel('radial', ELBOW_S * 0.45, [-22, 0, 8]),
    routeLabel('brachial', ELBOW_S + 120, [-24, 0, 6]),
    routeLabel('axillary', ELBOW_S + 270 + 50, [-55, -10, 8]),
    routeLabel('subclavian', ELBOW_S + 270 + 100 + 30, [-30, 30, 6]),
    routeLabel('brachiocephalic', AORTA_ENTRY_S - 20, [22, 80, 8]),
  ];
  return labels;
}
