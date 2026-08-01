import { CONFIG } from '../config';
import {
  isReducingUpgrade,
  UPGRADE_LABELS,
  UPGRADE_TRACKS,
  type MetaProgress,
  type UpgradeId,
  type UpgradeTrackId,
} from '../core/meta';
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

/** Вкладка таббара: кнопка вверху и её список улучшений. */
interface TrackView {
  tab: HTMLButtonElement;
  group: HTMLElement;
}

/**
 * Экраны результата забега и прокачки (ТЗ раздел 11).
 *
 * DOM-оверлей поверх холста, как HUD и подписи: текст резкий на любом
 * devicePixelRatio, кнопки работают из коробки и ничего не стоят по кадру.
 *
 * Вкладки и строки улучшений собираются из UPGRADE_TRACKS, а не размечаются
 * руками, — иначе список в HTML и список в коде разъезжались бы при добавлении
 * улучшения или ветки.
 */
export class Screens {
  private readonly resultElement: HTMLElement | null;
  private readonly upgradeElement: HTMLElement | null;
  private readonly resultTitle: HTMLElement | null;
  private readonly resultTime: HTMLElement | null;
  private readonly resultExpCaption: HTMLElement | null;
  private readonly resultRunExp: HTMLElement | null;
  private readonly resultBank: HTMLElement | null;
  private readonly upgradeBank: HTMLElement | null;

  private readonly rows = new Map<UpgradeId, UpgradeRow>();
  private readonly tracks = new Map<UpgradeTrackId, TrackView>();

  /**
   * Открытая вкладка. Держится между заходами на экран: игрок, качающий отряд,
   * не должен каждый забег заново переключаться со «своей» вкладки.
   */
  private activeTrack: UpgradeTrackId = UPGRADE_TRACKS[0]!.id;

  constructor(
    private readonly meta: MetaProgress,
    handlers: ScreenHandlers,
  ) {
    this.resultElement = document.querySelector<HTMLElement>('#screen-result');
    this.upgradeElement = document.querySelector<HTMLElement>('#screen-upgrade');
    this.resultTitle = document.querySelector<HTMLElement>('#result-title');
    this.resultTime = document.querySelector<HTMLElement>('#result-time');
    this.resultExpCaption = document.querySelector<HTMLElement>('#result-exp-caption');
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
  showResult(collectedExp: number, earnedExp: number, elapsedSeconds: number, wave: number): void {
    if (this.resultTitle !== null) this.resultTitle.textContent = `Волна ${wave}`;
    if (this.resultTime !== null) {
      // Причина конца забега в строке, а не в заголовке: заголовок занят счётом.
      this.resultTime.textContent = `Герой погиб · время ${formatRunTime(elapsedSeconds)}`;
    }

    // Множитель опыта применяется только здесь, поэтому число на экране больше
    // того, что стояло в HUD. Без подписи это выглядит ошибкой счётчика, поэтому
    // при множителе ≠ 1 рядом написано, из чего оно получилось.
    const multiplier = CONFIG.player.expMultiplier;
    if (this.resultExpCaption !== null) {
      this.resultExpCaption.textContent =
        multiplier === 1
          ? 'Опыт за забег'
          : `Опыт за забег · ${Math.floor(collectedExp)} × ${multiplier.toFixed(2)}`;
    }
    if (this.resultRunExp !== null) this.resultRunExp.textContent = `+${Math.floor(earnedExp)} EXP`;
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

  /**
   * Собирает таббар и по списку улучшений на каждую вкладку.
   *
   * Списки всех вкладок лежат в DOM одновременно, переключение — только показ
   * нужного. Пересобирать разметку на каждый клик незачем: строк меньше десятка,
   * зато так не теряется состояние кнопок и не мигает раскладка.
   */
  private buildRows(): void {
    const tabBar = document.querySelector<HTMLElement>('#upgrade-tabs');
    const list = document.querySelector<HTMLElement>('#upgrade-list');
    if (tabBar === null || list === null) return;

    for (const track of UPGRADE_TRACKS) {
      const tab = document.createElement('button');
      tab.className = 'upgrade-tab';
      tab.type = 'button';
      tab.textContent = track.title;
      tab.addEventListener('click', () => this.selectTrack(track.id));
      tabBar.appendChild(tab);

      const group = document.createElement('div');
      group.className = 'upgrade-group';
      list.appendChild(group);

      for (const id of track.ids) group.appendChild(this.buildRow(id));

      this.tracks.set(track.id, { tab, group });
    }

    this.selectTrack(this.activeTrack);
  }

  /** Одна строка улучшения. Возвращает готовый элемент, регистрируя его в rows. */
  private buildRow(id: UpgradeId): HTMLElement {
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
    // Текст проставляется в refreshUpgrades: на кнопке не потолок пачки, а
    // сколько уровней реально оплатит текущий банк.
    batch.addEventListener('click', () => {
      this.meta.buyBatch(id);
      this.refreshUpgrades();
    });

    row.append(name, meta, buy, batch);
    this.rows.set(id, { meta, buy, batch });
    return row;
  }

  /** Переключает вкладку таббара. */
  private selectTrack(id: UpgradeTrackId): void {
    this.activeTrack = id;

    for (const [trackId, view] of this.tracks) {
      const active = trackId === id;
      view.tab.classList.toggle('active', active);
      view.group.classList.toggle('visible', active);
    }
  }

  /** Перерисовывает уровни, эффекты и цены после каждой покупки. */
  private refreshUpgrades(): void {
    if (this.upgradeBank !== null) {
      this.upgradeBank.textContent = `${this.meta.bankDisplay} EXP`;
    }

    for (const track of UPGRADE_TRACKS) {
      // Метка «в этой вкладке есть что купить»: строки скрытых вкладок игрок не
      // видит, и без метки покупка в соседней ветке ничем себя не выдаёт.
      let ready = false;

      for (const id of track.ids) {
        const row = this.rows.get(id);
        if (row === undefined) continue;

        const level = this.meta.level(id);
        const max = this.meta.maxLevel(id);
        const cost = this.meta.nextCost(id);
        const current = this.meta.multiplier(id);
        const canBuy = this.meta.canBuy(id);
        ready ||= canBuy;

        // Показываем не только текущий множитель, но и следующий: иначе при шаге
        // в 1% непонятно, за что вообще платишь.
        const step = CONFIG.meta.upgrades[id].stepPercent / 100;
        const next = isReducingUpgrade(id) ? current - step : current + step;
        const effect =
          cost === null
            ? `${UPGRADE_LABELS[id].effect} ×${current.toFixed(2)}`
            : `${UPGRADE_LABELS[id].effect} ×${current.toFixed(2)} → ×${next.toFixed(2)}`;

        row.meta.textContent = `${level}/${max} · ${effect}`;
        row.buy.textContent = cost === null ? 'макс.' : `${cost} EXP`;
        row.buy.disabled = !canBuy;

        // Пачка тратит весь банк, но не больше batchSize уровней, — на кнопке
        // стоит фактическое число, чтобы было видно, за что жмёшь.
        const batchCount = this.meta.affordableLevels(id);
        row.batch.textContent = `×${batchCount}`;
        row.batch.disabled = batchCount === 0;
      }

      this.tracks.get(track.id)?.tab.classList.toggle('upgrade-tab--ready', ready);
    }
  }

  private toggle(element: HTMLElement | null, visible: boolean): void {
    if (element === null) return;
    element.classList.toggle('visible', visible);
  }
}
