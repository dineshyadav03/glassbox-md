import { describe, expect, it } from 'vitest';
import { DISCLAIMER, HEADLINE, TAGLINE } from '../src/ui/startContent';

describe('start screen content', () => {
  it('says plainly that it is educational and not clinical training, a device, or advice', () => {
    for (const phrase of ['Educational only', 'not clinical training', 'not a medical device', 'not medical advice', 'invented']) {
      expect(DISCLAIMER).toContain(phrase);
    }
  });

  it('is not connected to the diagnostic pipeline, and says so', () => {
    expect(DISCLAIMER).toContain('not connected to the diagnostic pipeline');
  });

  it('names the procedure', () => {
    expect(HEADLINE).toBe('Brain Surgery');
    expect(TAGLINE).toContain('IC-PC aneurysm');
  });
});
