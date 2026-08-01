import { Vector3, type PerspectiveCamera } from 'three';
import { CONFIG } from '../config';

/**
 * Оверлей в мировых координатах: подписи (число + иконка) и полоски HP над
 * игровыми объектами.
 *
 * Реализован DOM-элементами, спроецированными из 3D, а не спрайтами в сцене.
 * Причины: текст остаётся резким при любом devicePixelRatio, значение меняется
 * без перерисовки текстуры, а полоска — это два div'а вместо отдельной геометрии.
 *
 * Подписи и полоски лежат в ДВУХ разных пулах: у них разная разметка (два span
 * против дорожки с заливкой). Но проекция, кадровый цикл и размеры холста общие,
 * поэтому это один класс, а не два — иначе пришлось бы копировать проекцию и
 * дважды вызывать begin/end из Game.render.
 *
 * Работает в режиме «перерисовать список за кадр»: begin() → add()/addBar() на
 * каждый элемент → end(). Элементы берутся из пулов и переиспользуются, ничего
 * не создаётся и не удаляется по кадру.
 */
export class LabelLayer {
  private readonly root: HTMLElement | null;
  private readonly labelPool: HTMLElement[] = [];
  private readonly barPool: HTMLElement[] = [];
  private readonly projected = new Vector3();

  private labelsUsed = 0;
  private barsUsed = 0;
  private camera: PerspectiveCamera | null = null;
  private width = 0;
  private height = 0;

  // Результат проекции: заполняются project(), читаются вызывающим.
  private screenX = 0;
  private screenY = 0;

  constructor() {
    this.root = document.querySelector<HTMLElement>('#hud-labels');
  }

  /** Начинает кадр оверлея. Размеры — в CSS-пикселях холста. */
  begin(camera: PerspectiveCamera, cssWidth: number, cssHeight: number): void {
    this.camera = camera;
    this.width = cssWidth;
    this.height = cssHeight;
    this.labelsUsed = 0;
    this.barsUsed = 0;
  }

  /**
   * Подпись над точкой (x, y, z) мира.
   * variant — CSS-класс для окраски (например, состояние прочности бочки).
   */
  add(x: number, y: number, z: number, value: string, icon: string, variant: string): void {
    if (!this.project(x, y, z)) return;

    const element = this.acquireLabel();
    // Порядок важен: CSS применяет трансформы справа налево, поэтому сначала
    // элемент центрируется по своей ширине, потом уезжает в точку экрана.
    element.style.transform = `translate(${this.screenX}px, ${this.screenY}px) translate(-50%, -100%)`;

    const iconElement = element.firstElementChild as HTMLElement;
    const valueElement = element.lastElementChild as HTMLElement;

    // DOM трогаем только при изменении — иначе лишние пересчёты раскладки.
    // Иконка бывает и текстом (эмодзи), и разметкой SVG (стволы), поэтому
    // сравнение идёт по dataset, а не по textContent: у SVG он пустой, и разметка
    // перебиралась бы каждый кадр. Разметка своя, не пользовательская.
    if (iconElement.dataset.icon !== icon) {
      if (icon.startsWith('<svg')) iconElement.innerHTML = icon;
      else iconElement.textContent = icon;
      iconElement.dataset.icon = icon;
    }
    if (valueElement.textContent !== value) valueElement.textContent = value;
    if (element.dataset.variant !== variant) {
      element.className = `world-label world-label--${variant}`;
      element.dataset.variant = variant;
    }
  }

  /**
   * Полоска HP над точкой (x, y, z) мира. fraction — доля запаса, 0…1.
   * scale — множитель размера: у обычных зомби полоска мельче (см. конфиг).
   *
   * Заливка масштабируется по X, а не меняет width: transform не вызывает
   * пересчёт раскладки, а полосок в кадре может быть под сотню.
   */
  addBar(x: number, y: number, z: number, fraction: number, scale = 1): void {
    if (!this.project(x, y, z)) return;

    const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    const element = this.acquireBar();
    element.style.transform = `translate(${this.screenX}px, ${this.screenY}px) translate(-50%, -100%)`;

    // Размер выставляется на КАЖДОМ вызове, а не при создании: элементы берутся
    // из общего пула, и тот же самый мог в прошлом кадре обслуживать цель другого
    // размера. Пишем только при изменении — иначе лишний пересчёт раскладки.
    LabelLayer.applyBarSize(element, scale);

    const fill = element.firstElementChild as HTMLElement;
    // Округляем до процента: доля меняется каждый кадр, а разница ниже процента
    // на полоске в 26 пикселей всё равно не видна.
    const percent = Math.round(clamped * 100);
    if (element.dataset.fill !== String(percent)) {
      fill.style.transform = `scaleX(${percent / 100})`;
      element.dataset.fill = String(percent);
    }
  }

  /** Завершает кадр: лишние элементы обоих пулов прячутся. */
  end(): void {
    LabelLayer.hideRest(this.labelPool, this.labelsUsed);
    LabelLayer.hideRest(this.barPool, this.barsUsed);
  }

  /**
   * Проецирует мировую точку в экранные CSS-пиксели.
   * Возвращает false, если рисовать нельзя — тогда вызывающий просто выходит.
   */
  private project(x: number, y: number, z: number): boolean {
    if (this.camera === null || this.root === null) return false;

    this.projected.set(x, y, z).project(this.camera);
    // За камерой и за дальней плоскостью рисовать нельзя: проекция там
    // переворачивается и элемент улетает в случайную точку экрана.
    if (this.projected.z < -1 || this.projected.z > 1) return false;

    this.screenX = (this.projected.x * 0.5 + 0.5) * this.width;
    this.screenY = (-this.projected.y * 0.5 + 0.5) * this.height;
    return true;
  }

  private acquireLabel(): HTMLElement {
    let element = this.labelPool[this.labelsUsed];

    if (element === undefined) {
      element = document.createElement('div');
      element.className = 'world-label';

      const icon = document.createElement('span');
      icon.className = 'world-label__icon';
      const value = document.createElement('span');
      value.className = 'world-label__value';
      element.append(icon, value);

      this.root!.appendChild(element);
      this.labelPool.push(element);
    }

    if (element.style.display === 'none') element.style.display = '';
    this.labelsUsed++;

    return element;
  }

  /** Размер полоски по множителю. Дробные пиксели сохраняются (см. конфиг). */
  private static applyBarSize(element: HTMLElement, scale: number): void {
    const key = String(scale);
    if (element.dataset.scale === key) return;

    const { width, height } = CONFIG.ui.hpBar;
    element.style.width = `${width * scale}px`;
    element.style.height = `${height * scale}px`;
    element.dataset.scale = key;
  }

  private acquireBar(): HTMLElement {
    let element = this.barPool[this.barsUsed];

    if (element === undefined) {
      element = document.createElement('div');
      element.className = 'world-bar';

      const fill = document.createElement('div');
      fill.className = 'world-bar__fill';
      element.appendChild(fill);

      this.root!.appendChild(element);
      this.barPool.push(element);
    }

    if (element.style.display === 'none') element.style.display = '';
    this.barsUsed++;

    return element;
  }

  private static hideRest(pool: HTMLElement[], used: number): void {
    for (let i = used; i < pool.length; i++) {
      const element = pool[i]!;
      if (element.style.display !== 'none') element.style.display = 'none';
    }
  }
}
