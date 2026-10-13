import { renderStartScreen } from './ui/startScreen';

const root = document.getElementById('app');
if (!root) throw new Error('index.html is missing <div id="app">');
renderStartScreen(root);
