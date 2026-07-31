import { CONFIG } from './config';
import { Game } from './core/game';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');

if (!canvas) {
  throw new Error('Не найден #game-canvas в index.html');
}

const game = new Game(canvas);
game.start();

// Dev-хук: из консоли браузера можно читать состояние (game.squad.debugSnapshot(),
// game.world.scrollOffset) и крутить числа на живой игре (CONFIG.world.worldSpeed = 12).
if (import.meta.env.DEV) {
  Object.assign(window, { __game: game, __config: CONFIG });
}

// Правки в модулях не должны оставлять висящий game loop.
if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
