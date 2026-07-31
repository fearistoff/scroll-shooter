import { CONFIG } from '../config';

export type UpdateFn = (dt: number) => void;
export type RenderFn = () => void;

/**
 * Game loop с фиксированным шагом обновления.
 *
 * Логика всегда получает постоянный dt (1/60) — от частоты кадров не зависят ни
 * скорострельность, ни скорость мира, ни таймеры мин. Рендер идёт с частотой
 * монитора. Накопитель ограничен сверху, поэтому после возврата из фоновой
 * вкладки игра не отматывает полминуты за один кадр.
 */
export class GameLoop {
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;

  // Счётчики для отладочного вывода FPS.
  private fpsFrames = 0;
  private fpsElapsed = 0;

  private readonly onVisibilityChange = () => {
    if (!document.hidden) {
      // Вкладка вернулась в фокус — начинаем отсчёт заново, а не догоняем.
      this.lastTime = performance.now();
      this.accumulator = 0;
    }
  };

  constructor(
    private readonly update: UpdateFn,
    private readonly render: RenderFn,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
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

    const { fixedDt, maxFrameTime, maxStepsPerFrame } = CONFIG.loop;

    const frameTime = Math.min((now - this.lastTime) / 1000, maxFrameTime);
    this.lastTime = now;
    this.accumulator += frameTime;

    let steps = 0;
    while (this.accumulator >= fixedDt && steps < maxStepsPerFrame) {
      this.update(fixedDt);
      this.accumulator -= fixedDt;
      steps++;
    }

    // Не успели догнать за отведённые шаги — сбрасываем долг, иначе он копится.
    if (steps === maxStepsPerFrame) {
      this.accumulator = 0;
    }

    this.render();

    if (CONFIG.debug.logFps) {
      this.fpsFrames++;
      this.fpsElapsed += frameTime;
      if (this.fpsElapsed >= 1) {
        console.log(`fps: ${Math.round(this.fpsFrames / this.fpsElapsed)}`);
        this.fpsFrames = 0;
        this.fpsElapsed = 0;
      }
    }
  };
}
