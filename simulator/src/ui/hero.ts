import { svg } from './dom';

/**
 * The start screen's picture: a guide catheter coming down to the left coronary tree, with the 90% lesion in the LAD
 * marked. Drawn as SVG in code, so there is no image to ship. It is a schematic, not anatomy.
 */
export function createHero(): SVGSVGElement {
  const vessel = (d: string, width: number): SVGElement[] => [
    svg('path', { d, class: 'hero-glow', 'stroke-width': width + 6 }),
    svg('path', { d, class: 'hero-vessel', 'stroke-width': width }),
  ];
  const label = (text: string, x: number, y: number): SVGElement => {
    const node = svg('text', { x, y, class: 'hero-label' });
    node.textContent = text;
    return node;
  };

  const blur = svg('filter', { id: 'hero-blur', x: '-30%', y: '-30%', width: '160%', height: '160%' }, [svg('feGaussianBlur', { stdDeviation: 6 })]);
  const fade = svg('radialGradient', { id: 'hero-fade', cx: '50%', cy: '45%', r: '60%' }, [
    svg('stop', { offset: '0%', 'stop-color': '#1b2733' }),
    svg('stop', { offset: '100%', 'stop-color': '#0b1016' }),
  ]);

  const lesion = svg('g', { class: 'hero-lesion' }, [
    svg('circle', { cx: 227, cy: 286, r: 17, class: 'hero-ring' }),
    svg('path', { d: 'M 244 276 L 292 252 L 360 252', class: 'hero-callout' }),
    label('90% lesion', 296, 246),
  ]);

  return svg(
    'svg',
    { viewBox: '0 0 520 440', class: 'hero', role: 'img', 'aria-label': 'Schematic of a guide catheter at the left coronary arteries, with a 90% narrowing in the LAD marked' },
    [
      svg('defs', {}, [blur, fade]),
      svg('rect', { x: 0, y: 0, width: 520, height: 440, rx: 18, fill: 'url(#hero-fade)' }),
      svg('path', {
        d: 'M 270 70 C 118 92 88 250 150 362 C 202 432 302 442 362 400 C 442 330 442 150 322 80 Z',
        class: 'hero-heart',
      }),
      ...vessel('M 272 140 C 236 190 224 270 236 392', 10),
      ...vessel('M 272 140 C 330 165 376 225 390 330', 8),
      ...vessel('M 241 236 C 205 248 176 284 170 336', 6),
      ...vessel('M 233 330 C 208 340 196 362 192 394', 5),
      ...vessel('M 262 92 L 272 140', 13),
      svg('path', { d: 'M 18 34 C 120 22 204 42 262 92', class: 'hero-catheter' }),
      svg('circle', { cx: 262, cy: 92, r: 5, class: 'hero-tip' }),
      label('LM', 282, 116),
      label('LAD', 196, 380),
      label('LCx', 388, 350),
      lesion,
    ],
  );
}
