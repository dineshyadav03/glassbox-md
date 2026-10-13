import type { LabelAnchor } from '../anatomy/labels';
import { buildAnatomyScene } from '../scene/anatomyScene';
import { createViewer } from '../scene/viewer';
import { NO_WEBGL_MESSAGE, PREVIEW_DISCLAIMER, PREVIEW_HINT, PREVIEW_KEYS, PREVIEW_NOTE, PREVIEW_TITLE } from './previewContent';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const child of children) node.append(child);
  return node;
}

/**
 * Show the 3D anatomy preview in `root`. `onBack` is called when the user leaves (button or Esc); the
 * preview has released its renderer and listeners by then. Text is set with textContent only.
 */
export function renderPreviewScreen(root: HTMLElement, onBack: () => void): void {
  const stage = el('div', { className: 'stage' });
  const info = el('p', { className: 'preview-info', text: PREVIEW_HINT });
  info.setAttribute('aria-live', 'polite');

  const labelsButton = el('button', { className: 'secondary', text: 'Labels (L)' });
  labelsButton.setAttribute('aria-pressed', 'true');
  const heartButton = el('button', { className: 'secondary', text: 'Frame heart (H)' });
  const routeButton = el('button', { className: 'secondary', text: 'Whole route (R)' });
  const backButton = el('button', { className: 'secondary', text: 'Back (Esc)' });

  const bar = el('header', { className: 'preview-bar' }, [
    el('div', {}, [el('h1', { text: PREVIEW_TITLE }), el('p', { className: 'preview-disclaimer', text: PREVIEW_DISCLAIMER })]),
    backButton,
  ]);
  const toolbar = el('div', { className: 'preview-toolbar' }, [heartButton, routeButton, labelsButton]);
  const keys = el(
    'dl',
    { className: 'preview-keys' },
    PREVIEW_KEYS.flatMap(([key, action]) => [el('dt', { text: key }), el('dd', { text: action })]),
  );

  root.replaceChildren(
    el('main', { className: 'preview' }, [
      bar,
      el('p', { className: 'preview-note', text: PREVIEW_NOTE }),
      stage,
      el('div', { className: 'preview-foot' }, [toolbar, info, keys]),
    ]),
  );

  const anatomy = buildAnatomyScene();
  const describe = (label: LabelAnchor | null): void => {
    info.textContent = label ? `${label.text}: ${label.detail}` : PREVIEW_HINT;
  };
  const viewer = createViewer(stage, anatomy, { onLabelHover: describe });

  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    window.removeEventListener('keydown', onKey);
    viewer?.dispose();
    onBack();
  };

  if (!viewer) {
    anatomy.dispose();
    const message = el('p', { className: 'status', text: NO_WEBGL_MESSAGE });
    message.setAttribute('role', 'alert');
    stage.replaceChildren(message);
    for (const button of [labelsButton, heartButton, routeButton]) button.disabled = true;
  }

  const toggleLabels = (): void => {
    if (!viewer) return;
    viewer.setLabelsVisible(!viewer.labelsVisible);
    labelsButton.setAttribute('aria-pressed', String(viewer.labelsVisible));
  };

  function onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key.toLowerCase()) {
      case 'l':
        toggleLabels();
        break;
      case 'h':
        viewer?.frameHeart();
        break;
      case 'r':
        viewer?.frameRoute();
        break;
      case 'escape':
        leave();
        break;
    }
  }

  labelsButton.addEventListener('click', toggleLabels);
  heartButton.addEventListener('click', () => viewer?.frameHeart());
  routeButton.addEventListener('click', () => viewer?.frameRoute());
  backButton.addEventListener('click', leave);
  window.addEventListener('keydown', onKey);
}
