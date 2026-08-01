/**
 * Запрет масштабирования страницы.
 *
 * `user-scalable=no` и `maximum-scale=1` в meta viewport iOS Safari игнорирует
 * с 10-й версии (там это решение доступности, разметкой его не отменить), так
 * что на айфоне игру можно было растащить щипком: холст уезжал за экран, а HUD
 * вместе с ним — вернуть масштаб обратно нечем, кнопок браузера в standalone
 * нет. Мета-тег оставлен ради остальных платформ, а на WebKit жесты гасятся
 * здесь.
 *
 * Двойной тап отключён отдельно, в CSS: `touch-action: manipulation` на body.
 * Гасить его же через preventDefault на touchend нельзя — вместе с жестом
 * отменяется click, и быстрые повторные покупки на экране прокачки перестали бы
 * доходить до кнопки.
 *
 * События gesture* нестандартные, есть только в WebKit, поэтому имена
 * приводятся строками, а слушатели ставятся non-passive: с passive
 * preventDefault ничего не делает.
 */
const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/** Ставит слушатели и возвращает функцию их снятия (нужна HMR-дизпоузу). */
export function lockZoom(): () => void {
  const onGesture = (event: Event) => event.preventDefault();

  for (const name of GESTURE_EVENTS) {
    document.addEventListener(name, onGesture, { passive: false });
  }

  return () => {
    for (const name of GESTURE_EVENTS) {
      document.removeEventListener(name, onGesture);
    }
  };
}
