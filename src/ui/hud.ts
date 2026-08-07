import { CONFIG } from '../config';
import { formatRunTime } from './time';

/**
 * Интерфейс забега.
 *
 * По ТЗ (раздел 9) сюда входят счётчик EXP слева вверху и полоса волны по центру
 * с числом оставшихся зомби. Под полосой — номер волны: босс не заканчивает забег,
 * а открывает следующую. Справа вверху — секундомер забега. HP героя и строка
 * счётчиков вынесены ВНИЗ экрана: наверху места уже нет, а под отрядом остаётся
 * свободная полоса дороги.
 *
 * Реализовано DOM-оверлеем, а не игровой графикой: текст остаётся резким на
 * любом devicePixelRatio, а по кадру ничего не стоит.
 */
export interface HudState {
  weapon: string;
  shooters: number;
  hiddenShooters: number;
  specials: number;
  enemies: number;
  bigEnemies: number;
  fastEnemies: number;
  /** Тел на дороге: они занимают слоты того же пула, что и живые зомби. */
  corpses: number;
  bullets: number;
  killed: number;
  barrels: number;
  barrelsBroken: number;
  mines: number;
  minesArmed: number;
  crystals: number;
  /** Монет денег на дороге — отладочный счётчик, как и кристаллы. */
  coins: number;
  exp: number;
  /** Собрано денег за забег — валюта магазина оружия. */
  money: number;
  /** Секунды с начала забега — секундомер справа вверху. */
  elapsedSeconds: number;
  /**
   * Частота кадров за последнюю секунду — только в отладочной строке. Шаг логики
   * теперь равен длине кадра, поэтому увидеть фактический fps важно: по нему
   * видно, идёт ли устройство на своих 120 Гц или просело.
   */
  fps: number;
  /** Номер волны, с 1. Волна сменяется после смерти босса. */
  wave: number;
  zombiesRemaining: number;
  zombiesTotal: number;
  /** Боссфайт: полоса волны заменяется многослойной полосой HP босса (ТЗ раздел 10). */
  boss: {
    active: boolean;
    hp: number;
    layersRemaining: number;
    layerFill: number;
  } | null;
}

/** Точка на холсте в CSS-пикселях: куда лететь подобранному. */
export interface HudAnchor {
  x: number;
  y: number;
}

export class Hud {
  private readonly rootElement: HTMLElement | null;
  private readonly expElement: HTMLElement | null;
  private readonly moneyElement: HTMLElement | null;
  private readonly waveElement: HTMLElement | null;
  private readonly waveCountElement: HTMLElement | null;
  private readonly waveBarElement: HTMLElement | null;
  private readonly waveFillElement: HTMLElement | null;
  private readonly waveLayersElement: HTMLElement | null;
  private readonly waveNumberElement: HTMLElement | null;
  private readonly debugElement: HTMLElement | null;
  /** Контейнер нижнего блока — в нём только отладочная строка счётчиков. */
  private readonly bottomElement: HTMLElement | null;
  private readonly timerElement: HTMLElement | null;

  /**
   * Отладочная строка счётчиков внизу — только в dev-режиме Vite.
   *
   * В собранной игре она не нужна и вводит в заблуждение: это внутренние числа, а
   * не интерфейс игрока. В PROD блок прячется один раз в конструкторе, а строка
   * даже не собирается — заодно уходит склейка десятка значений на кадр.
   */
  private readonly showDebug = import.meta.env.DEV;

  /** Последние выведенные значения — DOM трогаем только при изменении. */
  private lastExp = '';
  private lastMoney = '';
  private lastWaveCount = '';
  private lastWaveFill = -1;
  private lastLayers = '';
  private lastDebug = '';
  private lastTimer = '';
  private lastWaveNumber = '';
  private lastBossMode: boolean | null = null;
  private lastFillColor = '';
  private lastTrackColor = '';

  /**
   * Центры плашек EXP и денег в пикселях холста — цель полёта кристаллов и монет
   * (см. PickupPool). Меряются по требованию и кешируются: getBoundingClientRect
   * заставляет браузер пересчитать раскладку, а звать его каждый кадр не за чем —
   * плашка стоит на месте.
   *
   * Кеш сбрасывается ровно в двух случаях: сменился размер холста (ResizeObserver
   * ниже) и сменилась ДЛИНА строки счётчика. Не значение, а именно длина: в HUD
   * стоит font-variant-numeric: tabular-nums, все цифры одной ширины, и «EXP 12»
   * → «EXP 13» плашку не двигает.
   */
  private readonly expAnchorPoint: HudAnchor = { x: 0, y: 0 };
  private readonly moneyAnchorPoint: HudAnchor = { x: 0, y: 0 };
  private anchorsDirty = true;
  private readonly anchorObserver: ResizeObserver | null;

  /**
   * @param onPauseClick нажатие на контейнер секундомера — он же кнопка паузы.
   */
  constructor(onPauseClick: () => void) {
    this.rootElement = document.querySelector<HTMLElement>('#hud');
    this.expElement = document.querySelector<HTMLElement>('#hud-exp');
    this.moneyElement = document.querySelector<HTMLElement>('#hud-money');
    this.waveElement = document.querySelector<HTMLElement>('#hud-wave');
    this.waveCountElement = document.querySelector<HTMLElement>('#hud-wave-count');
    this.waveBarElement = document.querySelector<HTMLElement>('#hud-wave-bar');
    this.waveFillElement = document.querySelector<HTMLElement>('#hud-wave-fill');
    this.waveLayersElement = document.querySelector<HTMLElement>('#hud-wave-layers');
    this.waveNumberElement = document.querySelector<HTMLElement>('#hud-wave-number');
    this.debugElement = document.querySelector<HTMLElement>('#hud-debug');
    this.bottomElement = document.querySelector<HTMLElement>('#hud-bottom');
    // Текст идёт в отдельный span, а не в сам контейнер: рядом с ним лежит
    // значок паузы, и textContent на контейнере стирал бы его каждый кадр.
    this.timerElement = document.querySelector<HTMLElement>('#hud-timer-value');

    document.querySelector<HTMLElement>('#hud-timer')?.addEventListener('click', () => {
      onPauseClick();
    });

    if (!this.showDebug && this.bottomElement !== null) {
      this.bottomElement.style.display = 'none';
    }

    // Размер холста задаёт letterbox (Viewport), а не окно, поэтому наблюдаем за
    // самим оверлеем: событие resize приходит не на всякое изменение вьюпорта, а
    // ResizeObserver ловит бокс напрямую и срабатывает уже после раскладки.
    if (this.rootElement === null) {
      this.anchorObserver = null;
    } else {
      this.anchorObserver = new ResizeObserver(() => {
        this.anchorsDirty = true;
      });
      this.anchorObserver.observe(this.rootElement);
    }
  }

  /** Центр плашки EXP — туда летят кристаллы. */
  get expAnchor(): HudAnchor {
    this.measureAnchors();
    return this.expAnchorPoint;
  }

  /** Центр плашки денег — туда летят монеты. */
  get moneyAnchor(): HudAnchor {
    this.measureAnchors();
    return this.moneyAnchorPoint;
  }

  update(state: HudState): void {
    // Округляем вниз: EXP дробный (кристалл ×1.5 от прокачки), и без округления
    // в плашку лезло «EXP 330.72000000000065» — она распирала верхнюю строку и
    // налезала на полосу волны.
    const exp = `EXP ${Math.floor(state.exp)}`;
    // Деньги под EXP: валют две, и обе набираются по ходу забега. Всегда целые,
    // округлять нечего — находка округляется на выпадении (MoneyPool.dropFrom).
    const money = `$ ${state.money}`;

    // Плашка выросла на цифру — центр уехал, и цель полёта нужно перемерить.
    if (exp.length !== this.lastExp.length || money.length !== this.lastMoney.length) {
      this.anchorsDirty = true;
    }

    this.setText(this.expElement, exp, 'lastExp');
    this.setText(this.moneyElement, money, 'lastMoney');
    this.setText(this.timerElement, formatRunTime(state.elapsedSeconds), 'lastTimer');
    this.setText(this.waveNumberElement, `ВОЛНА ${state.wave}`, 'lastWaveNumber');

    const boss = state.boss;
    const bossMode = boss !== null && boss.active;
    if (bossMode !== this.lastBossMode && this.waveElement !== null) {
      this.waveElement.classList.toggle('boss', bossMode);
      this.lastBossMode = bossMode;
    }

    if (bossMode && boss !== null) {
      // Полоса волны заменяется полосой HP босса (ТЗ раздел 10):
      // красное число — суммарное оставшееся HP, «×N» — сколько слоёв осталось.
      this.setText(this.waveCountElement, String(Math.ceil(boss.hp)), 'lastWaveCount');
      this.setText(this.waveLayersElement, `×${boss.layersRemaining}`, 'lastLayers');
      this.setFill(boss.layerFill, Hud.layerColor(boss.layersRemaining));
      // За текущим слоем видно цвет следующего: сколько ещё снимать — понятно
      // сразу, не дожидаясь, пока полоса обнулится и перекрасится.
      this.setTrack(Hud.trackBackground(boss.layersRemaining - 1));
    } else {
      this.setText(this.waveCountElement, String(state.zombiesRemaining), 'lastWaveCount');
      this.setText(this.waveLayersElement, '', 'lastLayers');
      const fill = state.zombiesTotal > 0 ? state.zombiesRemaining / state.zombiesTotal : 0;
      this.setFill(fill, '');
      this.setTrack('');
    }

    if (!this.showDebug) return;

    const hidden = state.hiddenShooters > 0 ? ` (+${state.hiddenShooters} скрыто)` : '';
    const specials = state.specials > 0 ? ` · особое ×${state.specials}` : '';
    const big = state.bigEnemies > 0 ? ` (крупных ${state.bigEnemies})` : '';
    const fast = state.fastEnemies > 0 ? ` (быстрых ${state.fastEnemies})` : '';
    const corpses = state.corpses > 0 ? ` · тел ${state.corpses}` : '';
    const mines = state.mines > 0 ? ` · мины ${state.mines} (взвед. ${state.minesArmed})` : '';
    const debug =
      `отряд ${state.shooters}${hidden} · ${state.weapon}${specials} · ` +
      `зомби ${state.enemies}${big}${fast}${corpses} · убито ${state.killed} · пули ${state.bullets} · ` +
      `бочки ${state.barrels} (разбито ${state.barrelsBroken})${mines} · ` +
      `кристаллы ${state.crystals} · монеты ${state.coins} · fps ${state.fps}`;
    this.setText(this.debugElement, debug, 'lastDebug');
  }

  private setText(
    element: HTMLElement | null,
    text: string,
    cacheKey:
      | 'lastExp'
      | 'lastMoney'
      | 'lastWaveCount'
      | 'lastLayers'
      | 'lastDebug'
      | 'lastTimer'
      | 'lastWaveNumber',
  ): void {
    if (element === null || this[cacheKey] === text) return;
    element.textContent = text;
    this[cacheKey] = text;
  }

  /**
   * Заполненность полосы и её цвет.
   * Округляем до процента: масштаб меняется каждый кадр, а разница ниже процента
   * на экране всё равно не видна.
   */
  private setFill(fraction: number, color: string): void {
    if (this.waveFillElement === null) return;

    const rounded = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    if (rounded !== this.lastWaveFill) {
      this.waveFillElement.style.transform = `scaleX(${rounded / 100})`;
      this.lastWaveFill = rounded;
    }

    if (color !== this.lastFillColor) {
      // Пустая строка возвращает полосу к цвету из CSS (режим волны).
      this.waveFillElement.style.background = color;
      this.lastFillColor = color;
    }
  }

  /**
   * Фон дорожки — того, что видно за заливкой. Пустая строка возвращает тёмную
   * дорожку из CSS (режим волны и последний слой босса).
   */
  private setTrack(background: string): void {
    if (this.waveBarElement === null || background === this.lastTrackColor) return;

    this.waveBarElement.style.background = background;
    this.lastTrackColor = background;
  }

  /**
   * Перемер плашек счётчиков, если кеш устарел. Обе сразу: раскладка всё равно
   * пересчитывается целиком, и второй getBoundingClientRect уже бесплатный.
   */
  private measureAnchors(): void {
    if (!this.anchorsDirty || this.rootElement === null) return;

    // Координаты нужны относительно холста, а не окна: холст центрирован в окне
    // letterbox'ом, и слева от него бывают тёмные поля.
    const root = this.rootElement.getBoundingClientRect();
    Hud.measureCenter(this.expElement, root, this.expAnchorPoint);
    Hud.measureCenter(this.moneyElement, root, this.moneyAnchorPoint);
    this.anchorsDirty = false;
  }

  private static measureCenter(
    element: HTMLElement | null,
    root: DOMRect,
    out: HudAnchor,
  ): void {
    if (element === null) return;

    const rect = element.getBoundingClientRect();
    out.x = rect.left + rect.width * 0.5 - root.left;
    out.y = rect.top + rect.height * 0.5 - root.top;
  }

  dispose(): void {
    this.anchorObserver?.disconnect();
  }

  /** Цвет слоя полосы босса: каждый следующий слой другого цвета (ТЗ раздел 10). */
  private static layerColor(layersRemaining: number): string {
    const palette = CONFIG.boss.layerColors;
    if (palette.length === 0 || layersRemaining <= 0) return '';
    const index = (layersRemaining - 1) % palette.length;
    return palette[index] ?? '';
  }

  /**
   * Фон дорожки под слоем — цвет слоя в полную яркость сверху и потемневший до
   * CONFIG.boss.layerTrackGradient снизу, как у полосок HP стрелков и зомби.
   *
   * Градиент строится множителем по каналам, а не прозрачностью: дорожка обязана
   * быть непрозрачной, иначе сквозь неё проступает едущий мир (см. #hud-wave-bar
   * в styles.css).
   */
  private static trackBackground(layersRemaining: number): string {
    const color = Hud.layerColor(layersRemaining);
    if (color === '') return '';

    const value = Number.parseInt(color.slice(1), 16);
    const factor = CONFIG.boss.layerTrackGradient;
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    const bottom =
      `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`;
    return `linear-gradient(180deg, rgb(${r}, ${g}, ${b}), ${bottom})`;
  }
}
