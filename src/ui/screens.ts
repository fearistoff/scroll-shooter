import { CONFIG } from '../config';
import { UPGRADE_IDS, UPGRADE_LABELS, type MetaProgress, type UpgradeId } from '../core/meta';
import { formatRunTime } from './time';

/** Что экраны умеют сообщать наружу. */
export interface ScreenHandlers {
  /** Кнопка «Прокачка» на экране результата. */
  openUpgrade(): void;
  /** Кнопка «Начать забег» — есть и на экране прокачки, и на экране результата. */
  startRun(): void;
}

interface UpgradeRow {
  meta: HTMLElement;
  buy: HTMLButtonElement;
  batch: HTMLButtonElement;
}

/**
 * Экраны результата забега и прокачки (ТЗ раздел 11).
 *
 * DOM-оверлей поверх холста, как HUD и подписи: текст резкий на любом
 * devicePixelRatio, кнопки работают из коробки и ничего не стоят по кадру.
 *
 * Строки улучшений собираются из UPGRADE_IDS, а не размечаются руками, — иначе
 * список в HTML и список в коде разъезжались бы при добавлении улучшения.
 */
export class Screens {
  private readonly resultElement: HTMLElement | null;
  private readonly upgradeElement: HTMLElement | null;
  private readonly resultTitle: HTMLElement | null;
  private readonly resultTime: HTMLElement | null;
  private readonly resultRunExp: HTMLElement | null;
  private readonly resultBank: HTMLElement | null;
  private readonly upgradeBank: HTMLElement | null;

  private readonly rows = new Map<UpgradeId, UpgradeRow>();

  constructor(
    private readonly meta: MetaProgress,
    handlers: ScreenHandlers,
  ) {
    this.resultElement = document.querySelector<HTMLElement>('#screen-result');
    this.upgradeElement = document.querySelector<HTMLElement>('#screen-upgrade');
    this.resultTitle = document.querySelector<HTMLElement>('#result-title');
    this.resultTime = document.querySelector<HTMLElement>('#result-time');
    this.resultRunExp = document.querySelector<HTMLElement>('#result-run-exp');
    this.resultBank = document.querySelector<HTMLElement>('#result-bank');
    this.upgradeBank = document.querySelector<HTMLElement>('#upgrade-bank');

    document
      .querySelector<HTMLButtonElement>('#result-continue')
      ?.addEventListener('click', () => handlers.openUpgrade());

    // Один и тот же handlers.startRun() с двух экранов: путь в забег остаётся один.
    for (const selector of ['#upgrade-start', '#result-start']) {
      document
        .querySelector<HTMLButtonElement>(selector)
        ?.addEventListener('click', () => handlers.startRun());
    }

    document.querySelector<HTMLButtonElement>('#upgrade-reset')?.addEventListener('click', () => {
      this.meta.reset();
      this.refreshUpgrades();
    });

    this.buildRows();
  }

  /**
   * Экран результата забега.
   *
   * Исход всегда один — смерть героя: босс забег не заканчивает, а открывает
   * следующую волну, поэтому «победы» не существует. Достижением стала волна, до
   * которой игрок дошёл, и она вынесена в заголовок вместо слова «Поражение».
   * Время — тот же счётчик, что и в секундомере HUD.
   */
  showResult(runExp: number, elapsedSeconds: number, wave: number): void {
    if (this.resultTitle !== null) this.resultTitle.textContent = `Волна ${wave}`;
    if (this.resultTime !== null) {
      // Причина конца забега в строке, а не в заголовке: заголовок занят счётом.
      this.resultTime.textContent = `Герой погиб · время ${formatRunTime(elapsedSeconds)}`;
    }
    if (this.resultRunExp !== null) this.resultRunExp.textContent = `+${Math.floor(runExp)} EXP`;
    if (this.resultBank !== null) this.resultBank.textContent = `Всего: ${this.meta.bankDisplay} EXP`;

    this.toggle(this.resultElement, true);
    this.toggle(this.upgradeElement, false);
  }

  /** Экран прокачки. */
  showUpgrade(): void {
    this.refreshUpgrades();
    this.toggle(this.resultElement, false);
    this.toggle(this.upgradeElement, true);
  }

  /** Скрывает всё: идёт забег. */
  hide(): void {
    this.toggle(this.resultElement, false);
    this.toggle(this.upgradeElement, false);
  }

  private buildRows(): void {
    const list = document.querySelector<HTMLElement>('#upgrade-list');
    if (list === null) return;

    for (const id of UPGRADE_IDS) {
      const row = document.createElement('div');
      row.className = 'upgrade';

      const name = document.createElement('div');
      name.className = 'upgrade__name';
      name.textContent = UPGRADE_LABELS[id].title;

      const meta = document.createElement('div');
      meta.className = 'upgrade__meta';

      const buy = document.createElement('button');
      buy.className = 'upgrade__buy';
      buy.type = 'button';
      buy.addEventListener('click', () => {
        this.meta.buy(id);
        this.refreshUpgrades();
      });

      const batch = document.createElement('button');
      batch.className = 'upgrade__batch';
      batch.type = 'button';
      batch.textContent = `×${CONFIG.meta.batchSize}`;
      batch.addEventListener('click', () => {
        this.meta.buyBatch(id);
        this.refreshUpgrades();
      });

      row.append(name, meta, buy, batch);
      list.appendChild(row);
      this.rows.set(id, { meta, buy, batch });
    }
  }

  /** Перерисовывает уровни, эффекты и цены после каждой покупки. */
  private refreshUpgrades(): void {
    if (this.upgradeBank !== null) {
      this.upgradeBank.textContent = `${this.meta.bankDisplay} EXP`;
    }

    for (const id of UPGRADE_IDS) {
      const row = this.rows.get(id);
      if (row === undefined) continue;

      const level = this.meta.level(id);
      const max = this.meta.maxLevel(id);
      const cost = this.meta.nextCost(id);
      const current = this.meta.multiplier(id);

      // Показываем не только текущий множитель, но и следующий: иначе при шаге
      // в 1% непонятно, за что вообще платишь.
      const step = CONFIG.meta.upgrades[id].stepPercent / 100;
      const next = id === 'damageTaken' ? current - step : current + step;
      const effect =
        cost === null
          ? `${UPGRADE_LABELS[id].effect} ×${current.toFixed(2)}`
          : `${UPGRADE_LABELS[id].effect} ×${current.toFixed(2)} → ×${next.toFixed(2)}`;

      row.meta.textContent = `${level}/${max} · ${effect}`;
      row.buy.textContent = cost === null ? 'макс.' : `${cost} EXP`;
      row.buy.disabled = !this.meta.canBuy(id);
      row.batch.disabled = !this.meta.canBuy(id);
    }
  }

  private toggle(element: HTMLElement | null, visible: boolean): void {
    if (element === null) return;
    element.classList.toggle('visible', visible);
  }
}
