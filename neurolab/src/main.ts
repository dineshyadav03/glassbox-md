import { getLang, loadLang, saveLang, setLang } from './i18n';
import { renderStartScreen } from './ui/startScreen';

const root = document.getElementById('app');
if (!root) throw new Error('index.html is missing <div id="app">');
const app: HTMLElement = root;

setLang(loadLang());

function showStart(): void {
  document.documentElement.lang = getLang();
  renderStartScreen(app, {
    onEnter: () => void showLab(false),
    onDemo: () => void showLab(true),
    onLanguage: () => {
      const next = getLang() === 'en' ? 'ja' : 'en';
      setLang(next);
      saveLang(next);
      showStart();
    },
  });
}

/** The 3D code is loaded only when someone enters, so the start screen stays small and quick. */
async function showLab(demo: boolean): Promise<void> {
  const { renderLabScreen } = await import('./ui/labScreen');
  renderLabScreen(app, showStart, { demo });
}

showStart();
