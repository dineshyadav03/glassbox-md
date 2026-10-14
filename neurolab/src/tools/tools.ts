/** The ten tools: their names, keys, how they are used (a click or held down) and what each is for. */

export type ToolId = 'suction' | 'scissors' | 'bipolar' | 'dissector' | 'spatula' | 'clip' | 'icg' | 'doppler' | 'endoscope' | 'tempClip';

export interface ToolDef {
  readonly id: ToolId;
  readonly name: string;
  /** The key that picks it: 1 to 9, then 0. */
  readonly key: string;
  /** Held down while the pointer is pressed (true) or applied by a single click (false). */
  readonly hold: boolean;
  /** One line shown when the tool is picked. */
  readonly hint: string;
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'suction', name: 'Suction', key: '1', hold: true, hint: 'Hold to clear blood from the field. Keep it off the aneurysm.' },
  { id: 'scissors', name: 'Scissors', key: '2', hold: false, hint: 'Click an arachnoid membrane to cut it, outer one first.' },
  { id: 'bipolar', name: 'Bipolar', key: '3', hold: true, hint: 'Hold on a bleeding point to seal it. Too long on a vessel or nerve injures it.' },
  { id: 'dissector', name: 'Dissector', key: '4', hold: false, hint: 'Click the aneurysm neck to free it from the carotid. Keep off the dome.' },
  { id: 'spatula', name: 'Spatula', key: '5', hold: false, hint: 'Click to hold the lobes apart, as far as the cut membrane allows. Click again to release.' },
  { id: 'clip', name: 'Clip', key: '6', hold: false, hint: 'Click the freed neck to apply the clip. A and D turn it, W and S set blade depth, V swaps straight and curved.' },
  { id: 'icg', name: 'ICG', key: '7', hold: false, hint: 'Click to switch the fluorescence view: it lights the vessels that have blood flowing in them.' },
  { id: 'doppler', name: 'Doppler', key: '8', hold: false, hint: 'Click a vessel to listen for flow. Blood flowing gives a pulsing tone; none gives silence.' },
  { id: 'endoscope', name: 'Endoscope', key: '9', hold: false, hint: 'Click to open a small view from behind the aneurysm.' },
  { id: 'tempClip', name: 'Temporary clip', key: '0', hold: false, hint: 'Click the carotid to close it for a short time and slow bleeding. Click again to release. The clock runs.' },
];

export const TOOL_BY_ID: Readonly<Record<ToolId, ToolDef>> = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolId, ToolDef>;

/** The tool a number key picks, or undefined. */
export function toolForKey(key: string): ToolDef | undefined {
  return TOOLS.find((t) => t.key === key);
}
