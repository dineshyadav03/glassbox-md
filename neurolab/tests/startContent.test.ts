import { describe, expect, it } from 'vitest';
import { disclaimer, headline, tagline } from '../src/ui/startContent';

describe('start screen content', () => {
  it('says plainly that it is educational and not clinical training, a device, or advice', () => {
    for (const phrase of ['Educational only', 'not clinical training', 'not a medical device', 'not medical advice', 'invented']) {
      expect(disclaimer()).toContain(phrase);
    }
  });

  it('is not connected to the diagnostic pipeline, and says so', () => {
    expect(disclaimer()).toContain('not connected to the diagnostic pipeline');
  });

  it('names the procedure', () => {
    expect(headline()).toBe('Brain Surgery');
    expect(tagline()).toContain('IC-PC aneurysm');
  });
});
