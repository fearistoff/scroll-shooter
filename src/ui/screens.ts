import { CONFIG } from '../config';
import {
  isCountUpgrade,
  UPGRADE_LABELS,
  UPGRADE_TRACKS,
  type MetaProgress,
  type UpgradeId,
  type UpgradeTrackId,
} from '../core/meta';
import {
  getWeapon,
  isSpecialWeapon,
  shopWeapons,
  weaponIcon,
  WEAPON_NAMES,
  type WeaponId,
} from '../entities/weapons';
import { CHANGELOG, formatChangelogDate } from './changelog';
import { formatRunTime } from './time';

/** Что экраны умеют сообщать наружу. */
export interface ScreenHandlers {
  /** Кнопка «Прокачка» на экране результата. */
  openUpgrade(): void;
  /** Кнопка «Начать забег» — есть и на экране прокачки, и на экране результата. */
  startRun(): void;
  /** Кнопка «Продолжить» на экране паузы. */
  resume(): void;
}

/** Что показать на экране паузы: где именно забег остановлен. */
export interface PauseInfo {
  wave: number;
  elapsedSeconds: number;
}

/** Итог забега для экрана результата. */
export interface RunResult {
  /** Собрано кристаллов, без множителя прокачки — то же число, что было в HUD. */
  collectedExp: number;
  /** Сколько EXP ушло в банк: собранное × множитель. */
  earnedExp: number;
  /** Собрано монет, без множителя прокачки — то же число, что было в HUD. */
  collectedMoney: number;
  /** Сколько денег ушло в банк: собранное × множитель. */
  earnedMoney: number;
  elapsedSeconds: number;
  wave: number;
}

interface UpgradeRow {
  /** Название с текущим уровнем: «Урон (ур. 1)». Меняется после каждой покупки. */
  name: HTMLElement;
  /** Описание эффекта — единственная строка, которая не зависит от уровня. */
  effect: HTMLElement;
  /** Что даст следующая покупка: «Сл. ур.: ×1.00 → ×1.04». */
  next: HTMLElement;
  buy: HTMLButtonElement;
  batch: HTMLButtonElement;
}

/** Строка магазина оружия. Цена одна и навсегда, поэтому кнопка одна. */
interface WeaponRow {
  root: HTMLElement;
  buy: HTMLButtonElement;
}

/**
 * Вкладки экрана прокачки. К трём веткам улучшений (UPGRADE_TRACKS) добавлен
 * магазин оружия: он тоже мета-прогрессия, только за деньги и разовыми
 * покупками, поэтому живёт на том же экране, а не на своём.
 */
type ScreenTrackId = UpgradeTrackId | 'weapons';

/**
 * Порядок вкладок. Магазин стоит между стрелками и прочим: он про оружие, то
 * есть ближе к боевым веткам, чем к экономике, но покупается реже них —
 * открытый ствол работает уже навсегда.
 */
const TRACK_ORDER: readonly ScreenTrackId[] = ['hero', 'ally', 'weapons', 'common'];

/** Вкладка таббара: кнопка вверху и её список. */
interface TrackView {
  tab: HTMLButtonElement;
  group: HTMLElement;
}

/**
 * Подписи кнопки сброса по числу нажатий подряд.
 *
 * Сброс необратим и стирает всё накопленное, поэтому между намерением и делом
 * стоят два подтверждения — прямо на кнопке, а не отдельным окном: диалогов
 * экран не знает, а одиночное нажатие по кнопке рядом с «Начать забег» иначе
 * обошлось бы игроку в весь прогресс. Стирает последняя подпись в списке,
 * длина списка и есть число нажатий.
 */
const RESET_LABELS: readonly string[] = ['Сбросить прогресс', 'Вы уверены?', 'Точно?'];

/**
 * Строка итога по валюте на экране результата: «280 × 1.04 = 291 EXP».
 *
 * При множителе 1 умножать нечего и остаётся только сумма — «280 EXP»: писать
 * «× 1.00 =» на чистом сохранении значило бы показывать шум вместо результата.
 *
 * Показанное произведение может расходиться с показанными множителями на
 * единицу: collected у EXP дробный, а зачисляется целое (см. RunState.expEarned),
 * и в строку идёт уже округлённое. Верное здесь — итог, он же ушёл в банк.
 */
function formatEarned(
  collected: number,
  multiplier: number,
  earned: number,
  unit: string,
): string {
  if (multiplier === 1) return `${earned} ${unit}`;
  return `${collected} × ${multiplier.toFixed(2)} = ${earned} ${unit}`;
}

/**
 * Экраны результата забега и прокачки (ТЗ раздел 11).
 *
 * DOM-оверлей поверх холста, как HUD и подписи: текст резкий на любом
 * devicePixelRatio, кнопки работают из коробки и ничего не стоят по кадру.
 *
 * Вкладки и строки собираются из UPGRADE_TRACKS и CONFIG.shop, а не размечаются
 * руками, — иначе список в HTML и список в коде разъезжались бы при добавлении
 * улучшения, ветки или ствола.
 */
export class Screens {
  private readonly resultElement: HTMLElement | null;
  private readonly upgradeElement: HTMLElement | null;
  private readonly pauseElement: HTMLElement | null;
  private readonly pauseInfo: HTMLElement | null;
  private readonly changelogElement: HTMLElement | null;
  private readonly changelogList: HTMLElement | null;
  private readonly resultTitle: HTMLElement | null;
  private readonly resultTime: HTMLElement | null;
  private readonly resultRunExp: HTMLElement | null;
  private readonly resultRunMoney: HTMLElement | null;
  private readonly resultBank: HTMLElement | null;
  private readonly upgradeBank: HTMLElement | null;
  private readonly upgradeMoney: HTMLElement | null;
  private readonly upgradeReset: HTMLButtonElement | null;

  /** Сколько раз кнопку сброса нажали подряд — индекс в RESET_LABELS. */
  private resetStep = 0;

  private readonly rows = new Map<UpgradeId, UpgradeRow>();
  private readonly weaponRows = new Map<WeaponId, WeaponRow>();
  private readonly tracks = new Map<ScreenTrackId, TrackView>();

  /**
   * Открытая вкладка. Держится между заходами на экран: игрок, качающий отряд,
   * не должен каждый забег заново переключаться со «своей» вкладки.
   */
  private activeTrack: ScreenTrackId = TRACK_ORDER[0]!;

  constructor(
    private readonly meta: MetaProgress,
    handlers: ScreenHandlers,
  ) {
    this.resultElement = document.querySelector<HTMLElement>('#screen-result');
    this.upgradeElement = document.querySelector<HTMLElement>('#screen-upgrade');
    this.pauseElement = document.querySelector<HTMLElement>('#screen-pause');
    this.pauseInfo = document.querySelector<HTMLElement>('#pause-info');
    this.changelogElement = document.querySelector<HTMLElement>('#screen-changelog');
    this.changelogList = document.querySelector<HTMLElement>('#changelog-list');
    this.resultTitle = document.querySelector<HTMLElement>('#result-title');
    this.resultTime = document.querySelector<HTMLElement>('#result-time');
    this.resultRunExp = document.querySelector<HTMLElement>('#result-run-exp');
    this.resultRunMoney = document.querySelector<HTMLElement>('#result-run-money');
    this.resultBank = document.querySelector<HTMLElement>('#result-bank');
    this.upgradeBank = document.querySelector<HTMLElement>('#upgrade-bank');
    this.upgradeMoney = document.querySelector<HTMLElement>('#upgrade-money');
    this.upgradeReset = document.querySelector<HTMLButtonElement>('#upgrade-reset');

    document
      .querySelector<HTMLButtonElement>('#result-continue')
      ?.addEventListener('click', () => handlers.openUpgrade());

    document
      .querySelector<HTMLButtonElement>('#pause-resume')
      ?.addEventListener('click', () => handlers.resume());

    // Один и тот же handlers.startRun() с двух экранов: путь в забег остаётся один.
    for (const selector of ['#upgrade-start', '#result-start']) {
      document
        .querySelector<HTMLButtonElement>(selector)
        ?.addEventListener('click', () => handlers.startRun());
    }

    // Промежуточные нажатия перерисовывают только саму кнопку: refreshUpgrades
    // обнуляет счётчик подтверждений, и цепочка не дошла бы до конца.
    this.upgradeReset?.addEventListener('click', () => {
      this.resetStep++;
      if (this.resetStep < RESET_LABELS.length) {
        this.refreshReset();
        return;
      }

      this.meta.reset();
      this.refreshUpgrades();
    });

    // Версия ставится один раз: в течение сессии она не меняется. Нажатие на
    // неё открывает историю версий — отдельной кнопки для неё на экране нет:
    // номер сборки и есть та подпись, у которой историю ищут.
    const version = document.querySelector<HTMLElement>('#upgrade-version');
    if (version !== null) {
      version.textContent = `v${__APP_VERSION__}`;
      version.addEventListener('click', () => this.showChangelog());
    }

    document
      .querySelector<HTMLButtonElement>('#changelog-close')
      ?.addEventListener('click', () => this.hideChangelog());

    // Esc закрывает историю. Пауза тот же Esc ловит своим слушателем в Game, но
    // открыта история только с экрана прокачки, где пауза и так запрещена, —
    // разойтись эти два обработчика не могут.
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.changelogElement?.classList.contains('visible') !== true) return;
      event.preventDefault();
      this.hideChangelog();
    });

    this.buildRows();
    this.buildChangelog();
  }

  /**
   * Экран результата забега.
   *
   * Исход всегда один — смерть героя: босс забег не заканчивает, а открывает
   * следующую волну, поэтому «победы» не существует. Достижением стала волна, до
   * которой игрок дошёл, и она вынесена в заголовок вместо слова «Поражение».
   * Время — тот же счётчик, что и в секундомере HUD.
   */
  showResult(result: RunResult): void {
    if (this.resultTitle !== null) this.resultTitle.textContent = `Волна ${result.wave}`;
    if (this.resultTime !== null) {
      // Причина конца забега в строке, а не в заголовке: заголовок занят счётом.
      this.resultTime.textContent = `Герой погиб · время ${formatRunTime(result.elapsedSeconds)}`;
    }

    // Множители прокачки применяются только на выходе из забега, поэтому числа
    // на экране больше тех, что стояли в HUD. Показываем умножение целиком —
    // «собрано × множитель = зачислено», иначе разница читается как ошибка
    // счётчика. Обе валюты показываются всегда, даже нулевые: пустая строка
    // выглядела бы поломкой, а ноль честно говорит, что за забег не выпало.
    if (this.resultRunExp !== null) {
      this.resultRunExp.textContent = formatEarned(
        Math.floor(result.collectedExp),
        CONFIG.player.expMultiplier,
        Math.floor(result.earnedExp),
        'EXP',
      );
    }
    if (this.resultRunMoney !== null) {
      this.resultRunMoney.textContent = formatEarned(
        result.collectedMoney,
        CONFIG.player.moneyMultiplier,
        result.earnedMoney,
        '$',
      );
    }
    if (this.resultBank !== null) {
      this.resultBank.textContent = `Всего: ${this.meta.bankDisplay} EXP · ${this.meta.money} $`;
    }

    this.toggle(this.resultElement, true);
    this.toggle(this.upgradeElement, false);
  }

  /** Экран прокачки. */
  showUpgrade(): void {
    this.refreshUpgrades();
    this.toggle(this.resultElement, false);
    this.toggle(this.upgradeElement, true);
  }

  /**
   * Экран паузы. Строкой под заголовком — где забег остановлен: на паузе HUD
   * замирает под оверлеем, и без неё непонятно, к чему возвращаешься.
   */
  showPause(info: PauseInfo): void {
    if (this.pauseInfo !== null) {
      this.pauseInfo.textContent = `Волна ${info.wave} · ${formatRunTime(info.elapsedSeconds)}`;
    }
    this.toggle(this.pauseElement, true);
  }

  /** Снимает только паузу: результат и прокачка под ней оказаться не могут. */
  hidePause(): void {
    this.toggle(this.pauseElement, false);
  }

  /**
   * История версий поверх прокачки. Экран под ней не гасится: возвращаются с
   * истории всегда туда, откуда пришли, и лишнее переключение прокачки заново
   * дёргало бы её вкладки.
   */
  showChangelog(): void {
    this.toggle(this.changelogElement, true);

    // Список длинный, а элемент один на все открытия: без сброса прокрутки
    // второй заход начинался бы с того места, где закончился первый, — то есть
    // не с последней версии, ради которой сюда и заходят. Строго ПОСЛЕ показа:
    // у скрытого display: none элемента раскладки нет, и присвоение scrollTop
    // молча ничего не делает — ЗАМЕРЕНО, при обратном порядке прокрутка
    // оставалась на 1689 px.
    if (this.changelogList !== null) this.changelogList.scrollTop = 0;
  }

  hideChangelog(): void {
    this.toggle(this.changelogElement, false);
  }

  /** Скрывает всё: идёт забег. */
  hide(): void {
    this.toggle(this.resultElement, false);
    this.toggle(this.upgradeElement, false);
    this.toggle(this.pauseElement, false);
    this.toggle(this.changelogElement, false);
  }

  /**
   * Собирает таббар и списки вкладок.
   *
   * Списки всех вкладок лежат в DOM одновременно, переключение — только показ
   * нужного. Пересобирать разметку на каждый клик незачем: строк меньше двух
   * десятков, зато так не теряется состояние кнопок и не мигает раскладка.
   */
  private buildRows(): void {
    const tabBar = document.querySelector<HTMLElement>('#upgrade-tabs');
    const list = document.querySelector<HTMLElement>('#upgrade-list');
    if (tabBar === null || list === null) return;

    for (const id of TRACK_ORDER) {
      const track = UPGRADE_TRACKS.find((entry) => entry.id === id) ?? null;

      const tab = document.createElement('button');
      tab.className = 'upgrade-tab';
      tab.type = 'button';
      tab.textContent = track?.title ?? 'Оружие';
      tab.addEventListener('click', () => this.selectTrack(id));
      tabBar.appendChild(tab);

      const group = document.createElement('div');
      group.className = 'upgrade-group';
      list.appendChild(group);

      if (track !== null) {
        for (const upgradeId of track.ids) group.appendChild(this.buildRow(upgradeId));
      } else {
        for (const element of this.buildWeaponRows()) group.appendChild(element);
      }

      this.tracks.set(id, { tab, group });
    }

    this.selectTrack(this.activeTrack);
  }

  /**
   * Собирает список версий один раз при запуске.
   *
   * Данные постоянные, перерисовывать нечего, а собрать их лениво при первом
   * открытии значило бы поймать сборку двух десятков записей ровно в момент
   * нажатия. Двадцать записей в скрытом поддереве ничего не стоят.
   */
  private buildChangelog(): void {
    if (this.changelogList === null) return;

    for (const entry of CHANGELOG) {
      const root = document.createElement('div');
      root.className = 'changelog__entry';

      const head = document.createElement('div');
      head.className = 'changelog__head';

      const version = document.createElement('span');
      version.className = 'changelog__version';
      version.textContent = `v${entry.version}`;

      if (entry.version === __APP_VERSION__) {
        const badge = document.createElement('span');
        badge.className = 'changelog__current';
        badge.textContent = 'сейчас';
        version.appendChild(badge);
      }

      const date = document.createElement('span');
      date.className = 'changelog__date';
      date.textContent = formatChangelogDate(entry.date);

      head.append(version, date);

      const changes = document.createElement('ul');
      changes.className = 'changelog__changes';
      for (const text of entry.changes) {
        const item = document.createElement('li');
        item.textContent = text;
        changes.appendChild(item);
      }

      root.append(head, changes);
      this.changelogList.appendChild(root);
    }
  }

  /** Одна строка улучшения. Возвращает готовый элемент, регистрируя его в rows. */
  private buildRow(id: UpgradeId): HTMLElement {
    const row = document.createElement('div');
    row.className = 'upgrade';

    // Текст имени проставляется в refreshUpgrades: в нём стоит текущий уровень.
    const name = document.createElement('div');
    name.className = 'upgrade__name';

    const effect = document.createElement('div');
    effect.className = 'upgrade__effect';
    // Описание от уровня не зависит — единственная строка, которую хватает
    // проставить один раз. Первую букву поднимает CSS (::first-letter).
    effect.textContent = UPGRADE_LABELS[id].effect;

    const next = document.createElement('div');
    next.className = 'upgrade__next';

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

    row.append(name, effect, next, buy, batch);
    this.rows.set(id, { name, effect, next, buy, batch });
    return row;
  }

  /**
   * Строки магазина: сначала пистолет, затем цепочка покупок.
   *
   * Пистолет показан, хотя купить его нельзя: он начало цепочки, и без него
   * список открывается пистолетом-пулемётом, из чего не видно, что стартовый ствол
   * вообще есть и почему он не продаётся.
   */
  private buildWeaponRows(): HTMLElement[] {
    const starting = CONFIG.player.startWeapon as WeaponId;
    const entries: Array<{ id: WeaponId; price: number | null }> = [
      { id: starting, price: null },
      ...shopWeapons().map((entry) => ({ id: entry.id, price: entry.price })),
    ];

    return entries.map((entry) => this.buildWeaponRow(entry.id, entry.price));
  }

  /** Одна строка магазина. Цена null — стартовый ствол, он открыт всегда. */
  private buildWeaponRow(id: WeaponId, price: number | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'weapon';

    const icon = document.createElement('div');
    icon.className = 'weapon__icon';
    // Разметка иконки своя (SVG или эмодзи), поэтому innerHTML, а не textContent.
    // Источник — константа в коде, чужого текста здесь не бывает.
    icon.innerHTML = weaponIcon(id) ?? '🔫';

    const name = document.createElement('div');
    name.className = 'weapon__name';
    name.textContent = WEAPON_NAMES[id];

    // «Особое» — меткой у названия, а не словом в строке характеристик: там оно
    // занимало девять знаков, и строка переносилась на вторую строку, отчего
    // ряды огнемёта и гранатомёта были выше остальных. ЗАМЕРЕНО: колонка отдаёт
    // 185 px, строка без метки укладывается в них, с меткой — нет.
    if (isSpecialWeapon(id)) {
      const badge = document.createElement('span');
      badge.className = 'weapon__badge';
      badge.textContent = 'особое';
      name.appendChild(badge);
    }

    const stats = document.createElement('div');
    stats.className = 'weapon__stats';
    stats.textContent = Screens.weaponStats(id);

    const buy = document.createElement('button');
    buy.className = 'weapon__buy';
    buy.type = 'button';
    if (price !== null) {
      buy.addEventListener('click', () => {
        this.meta.buyWeapon(id);
        this.refreshUpgrades();
      });
    }

    row.append(icon, name, stats, buy);
    this.weaponRows.set(id, { root: row, buy });
    return row;
  }

  /**
   * Строка характеристик ствола: базовые числа из таблицы, БЕЗ прокачки.
   *
   * Без множителей намеренно: наборов их два (герой и стрелки), и показать один
   * значило бы соврать про второй. Сравнивать стволы между собой это не мешает —
   * множитель у обоих один и тот же.
   */
  private static weaponStats(id: WeaponId): string {
    const { damage, fireRate } = getWeapon(id);
    const dps = (damage * fireRate).toFixed(1);
    return `урон ${Screens.trim(damage)} · темп ${Screens.trim(fireRate)}/с · DPS ${dps}`;
  }

  /**
   * Число без хвоста нулей: 0.6667 → «0.67», 15 → «15».
   *
   * В таблице оружия есть значения, подобранные под ровный интервал между
   * выстрелами (гранатомёт, 0.6667 = раз в полторы секунды). Как есть они в
   * строку не годятся: четыре знака после запятой читаются как сбой вёрстки, а
   * toFixed(2) на целых дорисовал бы «15.00».
   */
  private static trim(value: number): string {
    return String(+value.toFixed(2));
  }

  /** Переключает вкладку таббара. */
  private selectTrack(id: ScreenTrackId): void {
    this.activeTrack = id;

    for (const [trackId, view] of this.tracks) {
      const active = trackId === id;
      view.tab.classList.toggle('active', active);
      view.group.classList.toggle('visible', active);
    }
  }

  /**
   * Перерисовывает уровни, эффекты и цены после каждой покупки.
   *
   * Заодно снимает начатое подтверждение сброса: сюда приходят и вход на экран,
   * и любая покупка, а между ними «Точно?» на кнопке висеть не должно — иначе
   * два нажатия через полчаса игры стёрли бы прогресс без предупреждения.
   */
  private refreshUpgrades(): void {
    this.resetStep = 0;
    this.refreshReset();

    if (this.upgradeBank !== null) {
      this.upgradeBank.textContent = `${this.meta.bankDisplay} EXP`;
    }
    if (this.upgradeMoney !== null) {
      this.upgradeMoney.textContent = `${this.meta.money} $`;
    }

    for (const track of UPGRADE_TRACKS) {
      // Метка «в этой вкладке есть что купить»: строки скрытых вкладок игрок не
      // видит, и без метки покупка в соседней ветке ничем себя не выдаёт.
      let ready = false;

      for (const id of track.ids) {
        const row = this.rows.get(id);
        if (row === undefined) continue;

        const level = this.meta.level(id);
        const cost = this.meta.nextCost(id);
        const canBuy = this.meta.canBuy(id);
        ready ||= canBuy;

        row.name.textContent = `${UPGRADE_LABELS[id].title} (ур. ${level})`;
        row.next.textContent = this.nextText(id, level, cost === null);
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

    this.refreshWeapons();
  }

  /**
   * Магазин: у каждой строки ровно три состояния — открыто, продаётся сейчас,
   * заперто предыдущим стволом. Последнее не прячется, а показывается тусклым с
   * ценой: игрок должен видеть всю цепочку и её стоимость наперёд.
   */
  private refreshWeapons(): void {
    const next = this.meta.nextWeapon();
    let ready = false;

    for (const [id, row] of this.weaponRows) {
      const owned = this.meta.isWeaponUnlocked(id);
      const onSale = next !== null && next.id === id;
      const price = this.meta.weaponPrice(id);
      const canBuy = this.meta.canBuyWeapon(id);
      ready ||= canBuy;

      row.root.classList.toggle('weapon--owned', owned);
      row.root.classList.toggle('weapon--locked', !owned && !onSale);

      if (owned) {
        // Стартовый ствол цены не имеет — у него и «куплено» не по адресу.
        row.buy.textContent = price === null ? 'старт' : 'куплено';
      } else {
        // Запертому — замок вместо кнопки: цена та же, но нажать нельзя, пока не
        // куплен предыдущий.
        row.buy.textContent = onSale ? `${price} $` : `🔒 ${price} $`;
      }
      row.buy.disabled = !canBuy;
    }

    this.tracks.get('weapons')?.tab.classList.toggle('upgrade-tab--ready', ready);
  }

  /**
   * Кнопка сброса: подпись по текущему шагу подтверждения и показ по тому,
   * есть ли что стирать.
   *
   * На пустом сохранении кнопки нет вовсе — до первой покупки она предлагала бы
   * действие без последствий, а сразу после сброса ещё и осталась бы висеть
   * подписью «Точно?». Прятание через hidden, а не класс: display у
   * .screen__button не переопределён, и умолчания атрибута хватает.
   */
  private refreshReset(): void {
    if (this.upgradeReset === null) return;

    this.upgradeReset.hidden = !this.meta.hasProgress;
    this.upgradeReset.textContent = RESET_LABELS[this.resetStep] ?? RESET_LABELS[0]!;
  }

  /**
   * Третья строка: что даст следующий уровень.
   *
   * Показана не для красоты — при шаге в 1% по одному текущему множителю
   * непонятно, за что вообще платишь. На максимальном уровне стрелки нет:
   * покупать больше нечего, поэтому там остаётся достигнутое значение.
   */
  private nextText(id: UpgradeId, level: number, maxed: boolean): string {
    const current = this.valueText(id, level);
    if (maxed) return `Максимум: ${current}`;
    return `Сл. ур.: ${current} → ${this.valueText(id, level + 1)}`;
  }

  /**
   * Значение улучшения на заданном уровне.
   *
   * Улучшения-счётчики (размер отряда) считаются в бойцах, поэтому у них «3»
   * без знака умножения: «×1.33» о размере отряда не сказало бы ничего.
   */
  private valueText(id: UpgradeId, level: number): string {
    if (isCountUpgrade(id)) return `${this.meta.countValue(id, level)}`;
    return `×${this.meta.multiplier(id, level).toFixed(2)}`;
  }

  private toggle(element: HTMLElement | null, visible: boolean): void {
    if (element === null) return;
    element.classList.toggle('visible', visible);
  }
}
