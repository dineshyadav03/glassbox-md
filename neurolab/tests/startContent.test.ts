import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n';
import { disclaimer, headline, tagline } from '../src/ui/startContent';

afterEach(() => setLang('en'));

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

  it('says the same things in Japanese', () => {
    setLang('ja');
    expect(headline()).toBe('脳外科手術');
    for (const phrase of ['教育用', '臨床訓練', '医療機器', '医学的助言', '架空', '診断パイプライン']) expect(disclaimer()).toContain(phrase);
  });
});
