import { CONFIG } from '../config';

export type UpdateFn = (dt: number) => void;
export type RenderFn = () => void;

/**
 * Game loop с шагом по частоте кадров устройства.
 *
 * Логика получает РЕАЛЬНУЮ длину кадра, а не фиксированные 1/60: на экране
 * 120 Гц мир двигается 120 раз в секунду, и движение перестаёт идти парами
 * одинаковых кадров. От частоты кадров при этом по-прежнему не зависит ничего:
 * все скорости и таймеры считаются от dt, темп огня — накопитель в WeaponState,
 * попадания — отрезок полёта за шаг.
 *
 * Шаг сверху ограничен `maxStepDt`: длинный кадр дробится на несколько равных
 * подшагов. Ограничение не про «частоту логики», а про дискретные события,
 * которые ловятся окном шириной «скорость × шаг» — пересечение линии героя
 * стеной, окно турникета, контакт бочки. Одним длинным шагом такое окно можно
 * перепрыгнуть, поэтому шаг не растёт, а дробится.
 *
 * Накопителя нет: за кадр отрабатывается ровно прошедшее время, остатка,
 * который сдвигал бы логику относительно картинки, не остаётся. Общая длина
 * кадра зажата сверху (`maxFrameTime`), поэтому после возврата из фоновой
 * вкладки игра не отматывает полминуты за раз.
 */
export class GameLoop {
  private rafId = 0;
  private lastTime = 0;
  private running = false;

  // Счётчики частоты кадров: для отладочной строки HUD и лога в консоль.
  private fpsFrames = 0;
  private fpsElapsed = 0;
  private fpsValue = 0;

  private readonly onVisibilityChange = () => {
    if (!document.hidden) {
      // Вкладка вернулась в фокус — начинаем отсчёт заново, а не догоняем.
      this.lastTime = performance.now();
    }
  };

  constructor(
    private readonly update: UpdateFn,
    private readonly render: RenderFn,
  ) {}

  /** Частота кадров, усреднённая за последнюю секунду. 0, пока не набралась. */
  get fps(): number {
    return this.fpsValue;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const { maxStepDt, stepTolerance, maxFrameTime, maxStepsPerFrame } = CONFIG.loop;

    const frameTime = Math.min((now - this.lastTime) / 1000, maxFrameTime);
    this.lastTime = now;

    /*
     * Кадр не длиннее потолка (с допуском) отрабатывается ОДНИМ шагом ровно по
     * своей длине: при 120 Гц это 1/120, при 60 Гц — 1/60. Более длинный кадр
     * делится на равные подшаги. Допуск обязателен — без него джиттер
     * вертикальной синхронизации раздваивает каждый кадр 60 Гц, см.
     * CONFIG.loop.stepTolerance.
     *
     * maxStepsPerFrame — защита от spiral of death: если и подшагов не хватило,
     * остаток времени отбрасывается, а не копится долгом (5 шагов по потолку —
     * около 0.09 с логики за кадр, дальше игра просто теряет отставание).
     *
     * Проверка frameTime > 0 нужна для двух кадров с одной меткой времени: шаг
     * нулевой длины ничего не двигает, но пробегает все подсистемы впустую.
     */
    if (frameTime > 0) {
      const wanted = Math.ceil(frameTime / maxStepDt - stepTolerance);
      const steps = Math.min(Math.max(wanted, 1), maxStepsPerFrame);
      const dt = Math.min(frameTime / steps, maxStepDt * (1 + stepTolerance));
      for (let i = 0; i < steps; i++) this.update(dt);
    }

    this.render();

    // Счётчик кадров идёт всегда: его показывает отладочная строка HUD, а лог в
    // консоль — отдельный флаг. Стоит он один инкремент за кадр.
    this.fpsFrames++;
    this.fpsElapsed += frameTime;
    if (this.fpsElapsed >= 1) {
      this.fpsValue = Math.round(this.fpsFrames / this.fpsElapsed);
      if (CONFIG.debug.logFps) console.log(`fps: ${this.fpsValue}`);
      this.fpsFrames = 0;
      this.fpsElapsed = 0;
    }
  };
}
