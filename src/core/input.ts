import { CONFIG } from '../config';

/**
 * Ввод: горизонтальная позиция pointer'а → положение отряда (ТЗ раздел 4).
 *
 * Всё считается в процентах, поэтому класс ничего не знает ни про разрешение
 * экрана, ни про игровые units — на выходе `targetPercent` 0…100:
 *   0   = крайнее левое положение отряда
 *   50  = центр дороги
 *   100 = крайнее правое положение
 * Перевод процентов в мировые координаты — забота Squad.
 *
 * По краям холста есть мёртвая зона (`CONFIG.input.deadZonePercent`): палец в
 * этой полосе означает, что отряд уже в крайнем положении. Живая полоса между
 * зонами растягивается на весь ход отряда.
 *
 *   0%        dead        живая полоса        dead      100%  ширина холста
 *   |----------|--------------------------------|----------|
 *              0%          отряд, %           100%
 *
 * Способ ввода зависит от устройства (CONFIG.input.followCursorWithoutPress):
 *   мышь — отряд идёт за курсором простым наведением, кнопку держать не нужно;
 *   тач  — только по касанию, потому что палец не умеет «наводиться».
 * Различаются по event.pointerType, поэтому на ноутбуке с тачскрином оба
 * способа доступны одновременно.
 */
export class PointerInput {
  /** Целевое положение отряда, % его хода. Читается на шаге логики. */
  targetPercent = 50;

  /** Id активного pointer'а. Второй палец игнорируется, чтобы не дёргал отряд. */
  private activePointerId: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerRelease);
    canvas.addEventListener('pointercancel', this.onPointerRelease);
    canvas.addEventListener('lostpointercapture', this.onPointerRelease);
  }

  /** Удерживается ли палец/кнопка прямо сейчас. */
  get isActive(): boolean {
    return this.activePointerId !== null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.activePointerId !== null) return;

    this.activePointerId = event.pointerId;
    // Отряд сразу переставляется под палец — так выбрана схема управления.
    this.updateTarget(event.clientX);

    // Захват нужен, чтобы драг продолжался, когда палец ушёл за пределы холста.
    // Может бросить NotFoundError, если pointer уже не активен (очень быстрый
    // тап). Тогда работаем без захвата — но ввод не теряем и обработчик не
    // роняем, иначе activePointerId залипнет и управление умрёт до перезагрузки.
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Не критично: без захвата драг просто ограничен площадью холста.
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.activePointerId !== null) {
      // Идёт касание или драг — ведёт только он, посторонние pointer'ы молчат.
      if (event.pointerId !== this.activePointerId) return;
      this.updateTarget(event.clientX);
      return;
    }

    // Ничего не нажато: курсор ведёт отряд наведением, палец — нет.
    // pointerType проверяем у каждого события, поэтому на гибридном устройстве
    // мышь и тач работают одновременно, каждый по своему правилу.
    if (CONFIG.input.followCursorWithoutPress && event.pointerType === 'mouse') {
      this.updateTarget(event.clientX);
    }
  };

  private readonly onPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.activePointerId = null;
    // targetPercent намеренно остаётся последним: отряд стоит там, где отпустили.
  };

  private updateTarget(clientX: number): void {
    // Читаем rect на каждое событие, а не кэшируем: холст летербоксится и
    // центрируется, после ресайза окна кэш дал бы смещение управления.
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;

    const pointerPercent = ((clientX - rect.left) / rect.width) * 100;

    // Зона зажата в 0…49: при 50 и выше живой полосы не осталось бы вовсе.
    const dead = Math.min(Math.max(CONFIG.input.deadZonePercent, 0), 49);
    const liveBand = 100 - dead * 2;

    const t = (pointerPercent - dead) / liveBand;
    this.targetPercent = Math.min(Math.max(t, 0), 1) * 100;
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerRelease);
    this.canvas.removeEventListener('pointercancel', this.onPointerRelease);
    this.canvas.removeEventListener('lostpointercapture', this.onPointerRelease);
  }
}
