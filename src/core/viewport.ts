import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { CONFIG } from '../config';

/**
 * Портретный холст под телефон.
 *
 * Соотношение сторон зажато в диапазон реальных телефонов
 * (viewport.minAspect … maxAspect), результат вписывается в видимую область и
 * центрируется, по бокам остаются тёмные поля. Так игра выглядит одинаково и на
 * телефоне, и в широком окне браузера на десктопе.
 *
 * РАЗМЕР СЧИТАЕТ CSS, А НЕ ЭТОТ КЛАСС. Здесь только передаются границы аспекта в
 * CSS-переменные и читается получившийся бокс холста. Так сделано после ошибки на
 * iOS: в standalone-режиме window.innerHeight отдаёт не ту величину, из которой
 * CSS раскладывает страницу, поэтому посчитанный в JS холст не совпадал с
 * разметкой и снизу оставалась чёрная полоса. Пока размер вычислялся в двух
 * местах, такой рассинхрон был возможен; теперь источник истины один.
 *
 * Отслеживание — ResizeObserver на самом холсте, а не событие resize: оно приходит
 * не на всякое изменение вьюпорта (сворачивание адресной строки, эмуляция
 * устройства в devtools), а бокс элемента наблюдатель ловит напрямую.
 */
export class Viewport {
  private width = 0;
  private height = 0;

  private readonly observer: ResizeObserver;
  private readonly onOrientationChange = () => this.apply();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: WebGLRenderer,
    private readonly camera: PerspectiveCamera,
  ) {
    Viewport.publishAspectBounds();
    this.apply();

    // Наблюдаем за холстом: его бокс — это и есть результат CSS-раскладки.
    this.observer = new ResizeObserver(() => this.apply());
    this.observer.observe(this.canvas);

    window.addEventListener('orientationchange', this.onOrientationChange);
  }

  /**
   * Отдаёт границы аспекта из конфига в CSS: формулу letterbox'а считает
   * #stage, а числа обязаны жить в одном месте — CONFIG.viewport.
   */
  private static publishAspectBounds(): void {
    const { minAspect, maxAspect } = CONFIG.viewport;
    const root = document.documentElement;
    root.style.setProperty('--min-aspect', String(minAspect));
    root.style.setProperty('--max-aspect', String(maxAspect));
  }

  /** Ширина холста в CSS-пикселях. */
  get cssWidth(): number {
    return this.width;
  }

  /** Высота холста в CSS-пикселях. */
  get cssHeight(): number {
    return this.height;
  }

  /** Ссылка на холст — понадобится для pointer-ввода в слое 1. */
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  private apply(): void {
    const { maxPixelRatio, narrowWidthPx } = CONFIG.viewport;

    // Бокс, который выдал CSS. getBoundingClientRect, а не clientWidth: дробные
    // размеры (dvh на 852.5 px) округляются здесь один раз и согласованно.
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width <= 0 || height <= 0) return;

    // Лишние setSize роняют производительность: ResizeObserver может дёргаться.
    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;

    // Класс для узкого холста: HUD по нему опускает полосу волны под верхнюю
    // строку. Медиа-запрос здесь не подошёл бы — он смотрит на окно, а холст
    // из-за letterbox'а бывает заметно меньше окна.
    this.canvas.parentElement?.classList.toggle('narrow', width < narrowWidthPx);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    // updateStyle = false: размером холста распоряжается CSS, и перезапись
    // style.width/height вернула бы прежний рассинхрон.
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.observer.disconnect();
    window.removeEventListener('orientationchange', this.onOrientationChange);
  }
}
