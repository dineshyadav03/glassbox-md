import { renderStartScreen } from './ui/startScreen';

const root = document.getElementById('app');
if (!root) throw new Error('index.html is missing <div id="app">');
const app: HTMLElement = root;

function showStart(): void {
  renderStartScreen(app, () => void showPreview());
}

/** The 3D code is loaded only when someone enters, so the start screen stays small and quick. */
async function showPreview(): Promise<void> {
  const { renderPreviewScreen } = await import('./ui/previewScreen');
  renderPreviewScreen(app, showStart);
}

showStart();
