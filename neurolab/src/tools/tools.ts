/** The ten tools: their names, keys, how they are used (a click or held down) and what each is for. */
import { t, type MessageKey } from '../i18n';

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

function tool(id: ToolId, key: string, hold: boolean): ToolDef {
  return {
    id,
    key,
    hold,
    get name(): string {
      return t(`tool.${id}.name` as MessageKey);
    },
    get hint(): string {
      return t(`tool.${id}.hint` as MessageKey);
    },
  };
}

export const TOOLS: readonly ToolDef[] = [
  tool('suction', '1', true),
  tool('scissors', '2', false),
  tool('bipolar', '3', true),
  tool('dissector', '4', false),
  tool('spatula', '5', false),
  tool('clip', '6', false),
  tool('icg', '7', false),
  tool('doppler', '8', true),
  tool('endoscope', '9', false),
  tool('tempClip', '0', false),
];

export const TOOL_BY_ID: Readonly<Record<ToolId, ToolDef>> = Object.fromEntries(TOOLS.map((def) => [def.id, def])) as Record<ToolId, ToolDef>;

/** The tool a number key picks, or undefined. */
export function toolForKey(key: string): ToolDef | undefined {
  return TOOLS.find((def) => def.key === key);
}
