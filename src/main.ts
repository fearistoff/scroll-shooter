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

/*
 * PWA: регистрация service worker'а, который предкеширует сборку целиком.
 *
 * Только в PROD: в dev-режиме воркер перехватывал бы запросы Vite и ломал HMR, а
 * сам файл sw.js генерируется на сборке (см. vite.config.ts) и в dev его нет.
 *
 * Путь относительный ('./sw.js'), потому что base сборки — './': игра может
 * лежать в подпапке, и от этого зависит и адрес воркера, и его scope.
 *
 * updateViaCache: 'none' — сам скрипт воркера никогда не берётся из HTTP-кеша,
 * иначе новая сборка могла бы не подхватиться на устройстве.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch((error) => {
      // Не падаем: без воркера игра просто теряет офлайн-режим. Частая причина —
      // небезопасный контекст: воркеры работают на localhost и по https, но не
      // по http на IP в локальной сети.
      console.warn('Service worker не зарегистрирован, офлайн-режим недоступен:', error);
    });
  });
}
