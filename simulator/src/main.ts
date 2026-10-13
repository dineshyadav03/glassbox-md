import { renderStartScreen } from './ui/startScreen';

const root = document.getElementById('app');
if (!root) throw new Error('index.html is missing <div id="app">');
const app: HTMLElement = root;

function showStart(): void {
  renderStartScreen(app, () => void showLab());
}

/** The 3D code is loaded only when someone enters, so the start screen stays small and quick. */
async function showLab(): Promise<void> {
  const { renderLabScreen } = await import('./ui/labScreen');
  renderLabScreen(app, showStart);
}

showStart();
