import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { CONFIG } from '../config';

/**
 * Портретный холст под телефон.
 *
 * Холст не растягивается на всё окно: соотношение сторон зажимается в диапазон
 * реальных телефонов (viewport.minAspect … maxAspect), результат вписывается в
 * окно и центрируется, по бокам остаются тёмные поля. Так игра выглядит
 * одинаково и на телефоне, и в широком окне браузера на десктопе.
 *
 * Отслеживание размера — через ResizeObserver, а не событие resize: оно приходит
 * не на всякое изменение вьюпорта (сворачивание адресной строки в мобильном
 * Safari, эмуляция устройства в devtools). ResizeObserver ловит изменение бокса
 * напрямую.
 */
export class Viewport {
  private width = 0;
  private height = 0;

  private readonly observer: ResizeObserver;
  private readonly onOrientationChange = () => this.apply();
  /** Изменения самой видимой области: адресная строка, клавиатура, вход в PWA. */
  private readonly onVisualResize = () => this.apply();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: WebGLRenderer,
    private readonly camera: PerspectiveCamera,
  ) {
    this.apply();

    this.observer = new ResizeObserver(() => this.apply());
    this.observer.observe(document.documentElement);

    window.addEventListener('orientationchange', this.onOrientationChange);
    // ResizeObserver на documentElement не ловит изменения visualViewport, а
    // размер холста считается теперь по нему — подписываемся отдельно.
    window.visualViewport?.addEventListener('resize', this.onVisualResize);
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

  /**
   * Доступная область в CSS-пикселях.
   *
   * Берётся из visualViewport, а не из window.innerHeight: в standalone-режиме на
   * iOS innerHeight отдаёт БОЛЬШУЮ величину, чем видимая область, и холст, посчитанный
   * от неё, не совпадал с тем, что раскладывает CSS, — снизу оставалась чёрная полоса.
   * visualViewport совпадает с единицей dvh, которой задана высота body.
   *
   * documentElement.clientHeight — запас для браузеров без visualViewport.
   */
  private static availableSize(): { width: number; height: number } {
    const visual = window.visualViewport;
    if (visual !== null && visual !== undefined && visual.width > 0 && visual.height > 0) {
      return { width: visual.width, height: visual.height };
    }
    const root = document.documentElement;
    return {
      width: root.clientWidth || window.innerWidth,
      height: root.clientHeight || window.innerHeight,
    };
  }

  private apply(): void {
    const { minAspect, maxAspect, maxPixelRatio } = CONFIG.viewport;

    const { width: availWidth, height: availHeight } = Viewport.availableSize();
    if (availWidth <= 0 || availHeight <= 0) return;

    const windowAspect = availWidth / availHeight;
    const aspect = Math.min(Math.max(windowAspect, minAspect), maxAspect);

    let width: number;
    let height: number;
    if (windowAspect > aspect) {
      // Окно шире, чем допустимо — упираемся в высоту, срезаем ширину.
      height = availHeight;
      width = height * aspect;
    } else {
      // Окно уже допустимого — упираемся в ширину, срезаем высоту.
      width = availWidth;
      height = width / aspect;
    }

    width = Math.round(width);
    height = Math.round(height);

    // Лишние setSize роняют производительность: ResizeObserver может дёргаться.
    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;

    // Контейнер холста тянем следом, иначе HUD поверх него разъедется с картинкой.
    const stage = this.canvas.parentElement;
    if (stage !== null) {
      stage.style.width = `${width}px`;
      stage.style.height = `${height}px`;

      // Класс для узкого холста: HUD по нему опускает полосу волны под верхнюю
      // строку. Медиа-запрос здесь не подошёл бы — он смотрит на окно, а размер
      // холста задаётся letterbox'ом и может быть заметно меньше окна.
      stage.classList.toggle('narrow', width < CONFIG.viewport.narrowWidthPx);
    }

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    this.renderer.setSize(width, height, true);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.observer.disconnect();
    window.removeEventListener('orientationchange', this.onOrientationChange);
    window.visualViewport?.removeEventListener('resize', this.onVisualResize);
  }
}
