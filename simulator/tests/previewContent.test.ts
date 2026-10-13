import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from '../src/ui/startContent';
import { NO_WEBGL_MESSAGE, PREVIEW_DISCLAIMER, PREVIEW_HINT, PREVIEW_KEYS, PREVIEW_NOTE } from '../src/ui/previewContent';

describe('anatomy preview content', () => {
  it('keeps the educational disclaimer on the preview screen, in the same terms as the start screen', () => {
    const text = PREVIEW_DISCLAIMER.toLowerCase();
    expect(text).toContain('educational');
    expect(text).toContain('not clinical training');
    expect(text).toContain('not medical advice');
    expect(DISCLAIMER.toLowerCase()).toContain('not medical advice');
  });

  it('says plainly that only the camera is interactive and the rest is not built yet', () => {
    const note = PREVIEW_NOTE.toLowerCase();
    expect(note).toContain('only the camera is interactive');
    expect(note).toContain('not built yet');
    expect(note).toContain('stylised');
  });

  it('documents every key the preview handles', () => {
    const keys = PREVIEW_KEYS.map(([k]) => k);
    for (const key of ['L', 'H', 'R', 'Esc']) expect(keys).toContain(key);
  });

  it('tells the user how to move the camera, and what to do when WebGL is missing', () => {
    expect(PREVIEW_HINT.toLowerCase()).toContain('drag');
    expect(NO_WEBGL_MESSAGE).toContain('WebGL');
  });
});
