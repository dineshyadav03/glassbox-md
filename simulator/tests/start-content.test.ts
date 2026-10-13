import { describe, expect, it } from 'vitest';
import { BUILD_STATUS, CASE_VIGNETTE, CONTROLS, DISCLAIMER, YOU_WILL } from '../src/ui/startContent';

describe('start screen content', () => {
  it('states that this is educational and not medical advice or clinical training', () => {
    const text = DISCLAIMER.toLowerCase();
    expect(text).toContain('educational');
    expect(text).toContain('not clinical training');
    expect(text).toContain('not medical advice');
    expect(text).toContain('no real patient data');
  });

  it('describes the specified case', () => {
    for (const fact of ['68-year-old', '80 kg', 'exertional angina', 'anterior ischaemia', '90% mid-LAD', 'radial']) {
      expect(CASE_VIGNETTE).toContain(fact);
    }
  });

  it('lists the six stages the learner will go through, ending with the debrief', () => {
    expect(YOU_WILL).toHaveLength(6);
    expect(YOU_WILL[5]?.toLowerCase()).toContain('debrief');
  });

  it('documents the specified key bindings', () => {
    const keys = CONTROLS.map(([k]) => k).join(' | ');
    for (const key of ['1 to 7', 'W / S', 'A / D', 'E (hold)', 'Tab', 'Esc']) expect(keys).toContain(key);
  });

  it('does not claim more is built than is', () => {
    expect(BUILD_STATUS.toLowerCase()).toContain('not built yet');
  });
});
