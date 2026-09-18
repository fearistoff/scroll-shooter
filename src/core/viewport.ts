import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { CONFIG } from '../config';

/**
 * Портретный холст под телефон.
 *
 * На телефоне холст занимает окно целиком — и по ширине, и по высоте. Ограничение
 * одно: окно шире портретного предела (viewport.maxAspect) режется по ширине и
 * центрируется, по бокам остаются тёмные поля. Так игра занимает весь экран
 * телефона и не растягивается на всю ширину монитора на десктопе.
 *
 * Нижней границы соотношения нет намеренно: на экране выше предела она давала
 * поля сверху и снизу, и на iPhone в standalone они не пересчитывались — высота
 * холста зависела только от ширины, а та не менялась, так что проверка «размер
 * тот же — выходим» гасила все последующие замеры, и полосы оставались навсегда.
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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: WebGLRenderer,
    private readonly camera: PerspectiveCamera,
  ) {
    this.apply();

    this.observer = new ResizeObserver(() => this.apply());
    this.observer.observe(document.documentElement);

    window.addEventListener('orientationchange', this.onOrientationChange);
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
    const { maxAspect, maxPixelRatio } = CONFIG.viewport;

    const availWidth = window.innerWidth;
    const availHeight = window.innerHeight;
    if (availWidth <= 0 || availHeight <= 0) return;

    const windowAspect = availWidth / availHeight;

    let width: number;
    let height: number;
    if (windowAspect > maxAspect) {
      // Окно шире портретного предела (десктоп, планшет в альбоме) — упираемся
      // в высоту и срезаем ширину, по бокам остаются тёмные поля.
      height = availHeight;
      width = height * maxAspect;
    } else {
      // Окно не шире предела — телефон. Холст занимает его целиком, высоту не
      // срезаем: на экране выше 19.5:9 вертикальный letterbox давал чёрные
      // полосы сверху и снизу, а на телефоне терять высоту незачем.
      // Соотношение уходит в камеру как есть, поэтому minAspect здесь не нужен.
      width = availWidth;
      height = availHeight;
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
      // строку. Медиа-запрос здесь не подошёл бы — он смотрит на окно, а на
      // широком десктопном окне холст режется по ширине и заметно уже него.
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
  }
}
