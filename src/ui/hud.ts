import { CONFIG } from '../config';
import { formatRunTime } from './time';

/**
 * Интерфейс забега.
 *
 * По ТЗ (раздел 9) сюда входят счётчик EXP слева вверху и полоса волны по центру
 * с числом оставшихся зомби и черепом, если в конце будет босс. Под полосой —
 * номер волны: босс не заканчивает забег, а открывает следующую. Справа вверху —
 * секундомер забега. HP героя и строка счётчиков вынесены ВНИЗ экрана: наверху
 * места уже нет, а под отрядом остаётся свободная полоса дороги.
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
  /** Номер волны, с 1. Волна сменяется после смерти босса. */
  wave: number;
  zombiesRemaining: number;
  zombiesTotal: number;
  hasBoss: boolean;
  /** Боссфайт: полоса волны заменяется многослойной полосой HP босса (ТЗ раздел 10). */
  boss: {
    active: boolean;
    hp: number;
    layersRemaining: number;
    layerFill: number;
  } | null;
}

export class Hud {
  private readonly expElement: HTMLElement | null;
  private readonly moneyElement: HTMLElement | null;
  private readonly waveElement: HTMLElement | null;
  private readonly waveCountElement: HTMLElement | null;
  private readonly waveFillElement: HTMLElement | null;
  private readonly waveSkullElement: HTMLElement | null;
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
  private lastSkull = '';
  private lastLayers = '';
  private lastDebug = '';
  private lastTimer = '';
  private lastWaveNumber = '';
  private lastBossMode: boolean | null = null;
  private lastFillColor = '';

  constructor() {
    this.expElement = document.querySelector<HTMLElement>('#hud-exp');
    this.moneyElement = document.querySelector<HTMLElement>('#hud-money');
    this.waveElement = document.querySelector<HTMLElement>('#hud-wave');
    this.waveCountElement = document.querySelector<HTMLElement>('#hud-wave-count');
    this.waveFillElement = document.querySelector<HTMLElement>('#hud-wave-fill');
    this.waveSkullElement = document.querySelector<HTMLElement>('#hud-wave-skull');
    this.waveLayersElement = document.querySelector<HTMLElement>('#hud-wave-layers');
    this.waveNumberElement = document.querySelector<HTMLElement>('#hud-wave-number');
    this.debugElement = document.querySelector<HTMLElement>('#hud-debug');
    this.bottomElement = document.querySelector<HTMLElement>('#hud-bottom');
    this.timerElement = document.querySelector<HTMLElement>('#hud-timer');

    if (!this.showDebug && this.bottomElement !== null) {
      this.bottomElement.style.display = 'none';
    }
  }

  update(state: HudState): void {
    // Округляем вниз: EXP дробный (кристалл ×1.5 от прокачки), и без округления
    // в плашку лезло «EXP 330.72000000000065» — она распирала верхнюю строку и
    // налезала на полосу волны.
    this.setText(this.expElement, `EXP ${Math.floor(state.exp)}`, 'lastExp');
    // Деньги под EXP: валют две, и обе набираются по ходу забега. Всегда целые,
    // округлять нечего — находка округляется на выпадении (MoneyPool.dropFrom).
    this.setText(this.moneyElement, `$ ${state.money}`, 'lastMoney');
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
      this.setText(this.waveSkullElement, '💀', 'lastSkull');
      this.setText(this.waveLayersElement, `×${boss.layersRemaining}`, 'lastLayers');
      this.setFill(boss.layerFill, Hud.layerColor(boss.layersRemaining));
    } else {
      this.setText(this.waveCountElement, String(state.zombiesRemaining), 'lastWaveCount');
      this.setText(this.waveSkullElement, state.hasBoss ? '💀' : '', 'lastSkull');
      this.setText(this.waveLayersElement, '', 'lastLayers');
      const fill = state.zombiesTotal > 0 ? state.zombiesRemaining / state.zombiesTotal : 0;
      this.setFill(fill, '');
    }

    if (!this.showDebug) return;

    const hidden = state.hiddenShooters > 0 ? ` (+${state.hiddenShooters} скрыто)` : '';
    const specials = state.specials > 0 ? ` · особое ×${state.specials}` : '';
    const big = state.bigEnemies > 0 ? ` (крупных ${state.bigEnemies})` : '';
    const corpses = state.corpses > 0 ? ` · тел ${state.corpses}` : '';
    const mines = state.mines > 0 ? ` · мины ${state.mines} (взвед. ${state.minesArmed})` : '';
    const debug =
      `отряд ${state.shooters}${hidden} · ${state.weapon}${specials} · ` +
      `зомби ${state.enemies}${big}${corpses} · убито ${state.killed} · пули ${state.bullets} · ` +
      `бочки ${state.barrels} (разбито ${state.barrelsBroken})${mines} · ` +
      `кристаллы ${state.crystals} · монеты ${state.coins}`;
    this.setText(this.debugElement, debug, 'lastDebug');
  }

  private setText(
    element: HTMLElement | null,
    text: string,
    cacheKey:
      | 'lastExp'
      | 'lastMoney'
      | 'lastWaveCount'
      | 'lastSkull'
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

  /** Цвет слоя полосы босса: каждый следующий слой другого цвета (ТЗ раздел 10). */
  private static layerColor(layersRemaining: number): string {
    const palette = CONFIG.boss.layerColors;
    if (palette.length === 0 || layersRemaining <= 0) return '';
    const index = (layersRemaining - 1) % palette.length;
    return palette[index] ?? '';
  }
}
