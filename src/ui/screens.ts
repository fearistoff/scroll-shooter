import { CONFIG } from '../config';
import {
  isCountUpgrade,
  STAT_BOOST_IDS,
  trimNumber,
  UPGRADE_LABELS,
  UPGRADE_TRACKS,
  upgradeEffect,
  upgradeValue,
  type MetaProgress,
  type StatBoostId,
  type UpgradeId,
  type UpgradeTrackId,
} from '../core/meta';
import {
  isSpecialWeapon,
  shootersIcon,
  shopWeapons,
  weaponBlastDamage,
  weaponBlastRadius,
  weaponDamage,
  weaponFireRate,
  weaponIcon,
  weaponRange,
  weaponUnlockWave,
  WEAPON_NAMES,
  type WeaponId,
} from '../entities/weapons';
import { CHANGELOG, formatChangelogDate } from './changelog';
import { formatRunTime } from './time';

/** Что экраны умеют сообщать наружу. */
export interface ScreenHandlers {
  /** Кнопка «Улучшения» на экране результата и «Назад» с бустеров. */
  openUpgrade(): void;
  /**
   * Кнопка «Начать забег» — есть и на экране прокачки, и на экране результата.
   * Забег с неё НЕ начинается: сначала открывается экран бустеров.
   */
  openBoosters(): void;
  /** Кнопка «В бой» на экране бустеров — единственный вход в забег. */
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
  /** Сколько EXP ушло в банк: собранное × множители ниже. */
  earnedExp: number;
  /** Множитель опыта от прокачки (ветка «Опыт»). В умножении стоит первым. */
  expUpgradeMultiplier: number;
  /** Множитель опыта от бустера: ×1.5, если буст взят в кит, иначе 1. Вторым. */
  expBoostMultiplier: number;
  /** Собрано монет, без множителя прокачки — то же число, что было в HUD. */
  collectedMoney: number;
  /** Сколько денег ушло в банк: собранное × множители ниже. */
  earnedMoney: number;
  /** Множитель денег от прокачки — как expUpgradeMultiplier. */
  moneyUpgradeMultiplier: number;
  /** Множитель денег от бустера — как expBoostMultiplier. */
  moneyBoostMultiplier: number;
  elapsedSeconds: number;
  wave: number;
  /**
   * Стволы, которые эта вылазка открыла к покупке: рекорд волны дотянул до их
   * замка (MetaProgress.weaponsOpenedByWave). Пустой список — открывать было
   * нечего, и строки на экране не будет.
   */
  unlockedWeapons: readonly WeaponId[];
}

interface UpgradeRow {
  /** Название с текущим уровнем: «Урон (ур. 1)». Меняется после каждой покупки. */
  name: HTMLElement;
  /** Фактическое состояние характеристики: «Базовый урон — 2.4 HP». */
  effect: HTMLElement;
  /** Что даст следующая покупка: «Сл. ур.: 2.5 HP». На максимуме — «Максимум». */
  next: HTMLElement;
  buy: HTMLButtonElement;
  batch: HTMLButtonElement;
  /** Подпись «Макс.» на месте кнопок, когда уровень последний. */
  maxed: HTMLElement;
}

/** Строка со стволом: в магазине и в бустерах разметка одна и та же. */
interface WeaponRow {
  root: HTMLElement;
  buy: HTMLButtonElement;
  /**
   * Урон и темп. Хранится, потому что числа считаются с прокачкой: купленный
   * уровень урона меняет их, не сходя с экрана, — значит строку надо
   * перерисовывать, а не проставить один раз при сборке.
   */
  stats: HTMLElement;
  /** Примечание особого ствола (Screens.weaponNote). Тоже с прокачкой. */
  note: HTMLElement;
  /**
   * Оверлей замка поверх всей строки: иконка и условие разблокировки на
   * размытом фоне (backdrop-filter). Показывается перерисовкой, когда строка
   * недоступна: в магазине — цепочкой или волной, в бустерах — доступностью
   * аренды. Заодно перехватывает клики по накрытой кнопке.
   */
  lock: HTMLElement;
  /** Текст условия разблокировки внутри оверлея. */
  lockText: HTMLElement;
  /** Подпись «Получено» на месте кнопки, когда ствол уже открыт. */
  owned: HTMLElement;
}

/**
 * Строка бойцов или буста на экране бустеров.
 *
 * НЕ наследует WeaponRow, хотя разметка та же: у ствола есть примечание особого
 * (weapon__note), а здесь — нет, и наследование заставляло бы держать в строке
 * пустой элемент только ради типа.
 *
 * refund — вторая кнопка «вернуть» у складывающихся покупок (бойцы, стартовая
 * волна). null — покупка одиночная, и её снимает та же кнопка buy («Убрать»),
 * как у строк аренды стволов.
 */
interface BoosterRow {
  root: HTMLElement;
  buy: HTMLButtonElement;
  name: HTMLElement;
  stats: HTMLElement;
  refund: HTMLButtonElement | null;
}

/**
 * Иконки, названия и вторые строки бустов характеристик. Величина прибавки в
 * названиях не зашита — она общая (+50%,
 * CONFIG.shop.startBonuses.statBoosts.multiplier) и дописывается перерисовкой,
 * чтобы правка конфига не разъезжалась с экраном. Вторая строка говорит, К
 * ЧЕМУ прибавка, а не как долго она действует: «одну вылазку» уже сказано
 * шапкой экрана. У предела отряда своей строки здесь нет — она собирается из
 * чисел конфига (см. refreshStatBoosts).
 */
const STAT_BOOST_VIEW: Record<StatBoostId, { icon: string; title: string; note: string }> = {
  shooters: { icon: '👥', title: 'Предел отряда', note: '' },
  damage: { icon: '💥', title: 'Урон', note: 'Ко всему урону отряда' },
  fireRate: { icon: '⚡', title: 'Скорострельность', note: 'К темпу огня всех стволов' },
  range: { icon: '🎯', title: 'Дальность', note: 'К дальности всех стволов' },
  exp: { icon: '💎', title: 'Опыт', note: 'К опыту за вылазку' },
  money: { icon: '💰', title: 'Деньги', note: 'К деньгам за вылазку' },
};

/**
 * Вкладки экрана прокачки. К трём веткам улучшений (UPGRADE_TRACKS) добавлен
 * магазин оружия: он тоже мета-прогрессия, только за деньги и разовыми
 * покупками, поэтому живёт на том же экране, а не на своём.
 *
 * Бустеры — наоборот, на своём (см. showBoosters): они действуют один забег, и
 * решаются перед конкретным забегом, а не вперемешку с вечными покупками.
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
  multipliers: readonly number[],
  earned: number,
  unit: string,
): string {
  // Единичные сомножители не показываются: «× 1.00» — шум, который к тому же
  // прятал бы за собой настоящий множитель. Порядок — как передан: прокачка,
  // затем бустер.
  const factors = multipliers.filter((value) => value !== 1);
  if (factors.length === 0) return `${earned} ${unit}`;
  const chain = factors.map((value) => `× ${value.toFixed(2)}`).join(' ');
  return `${collected} ${chain} = ${earned} ${unit}`;
}

/**
 * Форма слова при числе: 1 стрелок, 2 стрелка, 5 стрелков.
 *
 * Правило полное, с сотнями: бойцов в бустерах бывает до 22, то есть в диапазон
 * 11–14 (где «11 стрелков», а не «11 стрелок») попасть можно.
 */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return many;

  const units = count % 10;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
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
  private readonly boostersElement: HTMLElement | null;
  private readonly pauseElement: HTMLElement | null;
  private readonly pauseInfo: HTMLElement | null;
  private readonly changelogElement: HTMLElement | null;
  private readonly changelogList: HTMLElement | null;
  private readonly resultTitle: HTMLElement | null;
  private readonly resultTime: HTMLElement | null;
  private readonly resultRunExp: HTMLElement | null;
  private readonly resultRunMoney: HTMLElement | null;
  private readonly resultUnlocked: HTMLElement | null;
  private readonly resultBank: HTMLElement | null;
  private readonly upgradeBank: HTMLElement | null;
  private readonly upgradeMoney: HTMLElement | null;
  private readonly boostersMoney: HTMLElement | null;
  private readonly boostersSummary: HTMLElement | null;
  private readonly upgradeReset: HTMLButtonElement | null;

  /** Сколько раз кнопку сброса нажали подряд — индекс в RESET_LABELS. */
  private resetStep = 0;

  private readonly rows = new Map<UpgradeId, UpgradeRow>();
  private readonly weaponRows = new Map<WeaponId, WeaponRow>();
  /**
   * Строки «Доп. стрелкам» под стволами магазина: вторая цепочка покупок —
   * доступ стрелков к уже открытому герою оружию (MetaProgress.buyAllyWeapon).
   * Только в магазине: на бустерах аренда и так вооружает всех.
   */
  private readonly allyAccessRows = new Map<
    WeaponId,
    { buy: HTMLButtonElement; done: HTMLElement }
  >();
  /** Строки аренды: те же стволы, но на один забег. */
  private readonly boosterWeaponRows = new Map<WeaponId, WeaponRow>();
  /** Единственная строка бойцов на экране бустеров. null — разметки экрана нет вовсе. */
  private boosterShooterRow: BoosterRow | null = null;
  /** Строка стартовой волны на экране бустеров. null — разметки экрана нет вовсе. */
  private startWaveRow: BoosterRow | null = null;
  /** Строки бустов характеристик — по одной на каждый StatBoostId. */
  private readonly statBoostRows = new Map<StatBoostId, BoosterRow>();
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
    this.boostersElement = document.querySelector<HTMLElement>('#screen-boosters');
    this.pauseElement = document.querySelector<HTMLElement>('#screen-pause');
    this.pauseInfo = document.querySelector<HTMLElement>('#pause-info');
    this.changelogElement = document.querySelector<HTMLElement>('#screen-changelog');
    this.changelogList = document.querySelector<HTMLElement>('#changelog-list');
    this.resultTitle = document.querySelector<HTMLElement>('#result-title');
    this.resultTime = document.querySelector<HTMLElement>('#result-time');
    this.resultRunExp = document.querySelector<HTMLElement>('#result-run-exp');
    this.resultRunMoney = document.querySelector<HTMLElement>('#result-run-money');
    this.resultUnlocked = document.querySelector<HTMLElement>('#result-unlocked');
    this.resultBank = document.querySelector<HTMLElement>('#result-bank');
    this.upgradeBank = document.querySelector<HTMLElement>('#upgrade-bank');
    this.upgradeMoney = document.querySelector<HTMLElement>('#upgrade-money');
    this.boostersMoney = document.querySelector<HTMLElement>('#boosters-money');
    this.boostersSummary = document.querySelector<HTMLElement>('#boosters-kit');
    this.upgradeReset = document.querySelector<HTMLButtonElement>('#upgrade-reset');

    document
      .querySelector<HTMLButtonElement>('#result-continue')
      ?.addEventListener('click', () => handlers.openUpgrade());

    document
      .querySelector<HTMLButtonElement>('#pause-resume')
      ?.addEventListener('click', () => handlers.resume());

    // «Начать забег» с обоих экранов ведёт на бустеры, а не в забег: экран перед
    // забегом один и тот же, с какой бы стороны игрок к нему ни пришёл.
    for (const selector of ['#upgrade-start', '#result-start']) {
      document
        .querySelector<HTMLButtonElement>(selector)
        ?.addEventListener('click', () => handlers.openBoosters());
    }

    document
      .querySelector<HTMLButtonElement>('#boosters-start')
      ?.addEventListener('click', () => handlers.startRun());

    // Назад — всегда в прокачку, даже если пришли с результата: возвращаются
    // отсюда, чтобы что-то докупить, а покупается всё именно там.
    document
      .querySelector<HTMLButtonElement>('#boosters-back')
      ?.addEventListener('click', () => handlers.openUpgrade());

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

    // Пасхалка: нажатие на банк добавляет CONFIG.ui.devCheatAmount. Условие то
    // же, что у отладочной строки счётчиков в HUD (import.meta.env.DEV), то есть
    // работает только на локальном сервере — в собранной игре ни обработчика, ни
    // класса на плашках нет, и банк остаётся обычной подписью.
    if (import.meta.env.DEV) {
      this.bindDevCheat(this.upgradeBank, () => this.meta.deposit(CONFIG.ui.devCheatAmount));
      this.bindDevCheat(this.upgradeMoney, () => this.meta.depositMoney(CONFIG.ui.devCheatAmount));
    }

    this.buildRows();
    this.buildBoosters();
    this.buildChangelog();
  }

  /**
   * Подписывает плашку банка на dev-пасхалку и помечает её классом (в разметке
   * его нет — см. `.dev-cheat` в index.html).
   *
   * После начисления перерисовывается ВЕСЬ экран, а не только сама плашка: от
   * банка зависят и цены строк, и то, какие покупки стали доступны.
   */
  private bindDevCheat(element: HTMLElement | null, add: () => void): void {
    if (element === null) return;

    element.classList.add('dev-cheat');
    element.addEventListener('click', () => {
      add();
      this.refreshUpgrades();
    });
  }

  /**
   * Экран результата забега.
   *
   * Исход всегда один — смерть героя: босс забег не заканчивает, а открывает
   * следующую волну, поэтому «победы» не существует. В заголовке поэтому не
   * «Поражение», а нейтральное «Вылазка завершена»; достижением остаётся волна,
   * до которой игрок дошёл, и она стоит первой строкой под заголовком рядом со
   * временем — тем же счётчиком, что в секундомере HUD.
   */
  showResult(result: RunResult): void {
    if (this.resultTitle !== null) this.resultTitle.textContent = 'Вылазка завершена';
    if (this.resultTime !== null) {
      this.resultTime.textContent = `Волна ${result.wave} · время ${formatRunTime(result.elapsedSeconds)}`;
    }

    // Множители прокачки применяются только на выходе из забега, поэтому числа
    // на экране больше тех, что стояли в HUD. Показываем умножение целиком и
    // по сомножителям — «собрано × прокачка × бустер = зачислено», иначе
    // разница читается как ошибка счётчика, а слитый множитель не давал бы
    // понять, что бустер сработал. Считается ровно так же (run.expEarned —
    // собранное × тот же итоговый множитель), расходиться числам не с чего.
    // Обе валюты показываются всегда, даже нулевые: пустая строка выглядела бы
    // поломкой, а ноль честно говорит, что за забег не выпало.
    //
    // Подписей у сумм нет (решение пользователя, 2026-08-04): валюту называют
    // цвет строки — синий опыт и жёлтые деньги, как счётчики HUD, — и единица
    // в конце. Классы стоят прямо на строках в index.html.
    if (this.resultRunExp !== null) {
      this.resultRunExp.textContent = formatEarned(
        Math.floor(result.collectedExp),
        [result.expUpgradeMultiplier, result.expBoostMultiplier],
        Math.floor(result.earnedExp),
        'EXP',
      );
    }
    if (this.resultRunMoney !== null) {
      this.resultRunMoney.textContent = formatEarned(
        result.collectedMoney,
        [result.moneyUpgradeMultiplier, result.moneyBoostMultiplier],
        result.earnedMoney,
        '$',
      );
    }

    this.refreshResultUnlocked(result.unlockedWeapons);

    if (this.resultBank !== null) {
      this.resultBank.textContent = `Всего: ${this.meta.bankDisplay} EXP · ${this.meta.money} $`;
    }

    this.toggle(this.resultElement, true);
    this.toggle(this.upgradeElement, false);
  }

  /**
   * Строка «что открылось» — единственная новость экрана результата: волна, до
   * которой дошла эта вылазка, сняла замок с ступени магазина.
   *
   * Цена стоит рядом с названием, потому что открылось именно ПРАВО КУПИТЬ, а не
   * сам ствол: без цены строку можно прочитать как «оружие получено».
   *
   * Пусто — строки нет вовсе (как у сводки бустеров): «ничего не открылось»
   * писать незачем, это обычный исход почти каждой вылазки.
   */
  private refreshResultUnlocked(weapons: readonly WeaponId[]): void {
    if (this.resultUnlocked === null) return;

    this.resultUnlocked.hidden = weapons.length === 0;
    if (weapons.length === 0) return;

    // Через запятую, а не через « · », как в остальных строках экранов: строка
    // длинная и на телефоне переносится (ЗАМЕРЕНО при 375 px: два ствола дают
    // две строки), а точка-разделитель, оставшаяся висеть в конце первой из них,
    // читается как обрыв. Запятая на переносе выглядит обычным списком.
    const parts = weapons.map((id) => `${WEAPON_NAMES[id]} — ${this.meta.weaponPrice(id) ?? 0} $`);
    this.resultUnlocked.textContent = `Открылось в магазине: ${parts.join(', ')}`;
  }

  /** Экран прокачки. */
  showUpgrade(): void {
    this.refreshUpgrades();
    this.toggle(this.resultElement, false);
    this.toggle(this.boostersElement, false);
    this.toggle(this.upgradeElement, true);
  }

  /**
   * Экран бустеров — последний перед забегом (см. MetaProgress, «Стартовый кит»).
   *
   * Отдельным экраном, а не вкладкой прокачки, потому что покупка здесь другого
   * рода: она действует один забег и потому решается прямо перед ним. На пути в
   * бой он стоит всегда, даже когда денег нет вовсе, — иначе игрок узнавал бы о
   * бустерах, только если сам заглянет в нужную вкладку.
   */
  showBoosters(): void {
    this.refreshBoosters();
    this.toggle(this.resultElement, false);
    this.toggle(this.upgradeElement, false);
    this.toggle(this.boostersElement, true);
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
    this.toggle(this.boostersElement, false);
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

      const rows =
        track !== null
          ? track.ids.map((upgradeId) => this.buildRow(upgradeId))
          : this.buildWeaponRows();
      for (const element of rows) group.appendChild(element);

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
        badge.textContent = 'Сейчас';
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

    // Текст ставится в refreshUpgrades: у боевых характеристик здесь стоит их
    // фактическое состояние, а оно зависит от купленного уровня.
    const effect = document.createElement('div');
    effect.className = 'upgrade__effect';

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

    // Подпись вместо обеих кнопок на максимальном уровне. Отдельный элемент, а не
    // подпись на самой кнопке: неактивная кнопка «макс.» рядом с неактивной «×0»
    // читалась как «можно было бы купить, но нет денег», хотя покупать больше
    // нечего вовсе.
    const maxed = document.createElement('div');
    maxed.className = 'upgrade__maxed';
    maxed.textContent = 'Макс.';

    row.append(name, effect, next, buy, batch, maxed);
    this.rows.set(id, { name, effect, next, buy, batch, maxed });
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

    return entries.map((entry) => {
      const row = Screens.buildWeaponRow(entry.id);
      // Стартовому стволу кнопка досталась ради ровного ряда: она показывает
      // «старт» и нажатий не ловит — покупать его не за что.
      if (entry.price !== null) {
        row.buy.addEventListener('click', () => {
          this.meta.buyWeapon(entry.id);
          this.refreshUpgrades();
        });
        this.appendAllyAccessLine(row.root, entry.id);
      }
      this.weaponRows.set(entry.id, row);
      return row.root;
    });
  }

  /**
   * Строка доступа доп. стрелков — четвёртый ряд сетки ствола, только в
   * магазине. У пистолета её нет: он стартовый и открыт всем сразу.
   * Состояния повторяют геройскую кнопку: цена / замок / подпись «Открыто»
   * (см. refreshWeapons).
   */
  private appendAllyAccessLine(root: HTMLElement, id: WeaponId): void {
    root.classList.add('weapon--ally-access');

    const label = document.createElement('div');
    label.className = 'weapon__ally';
    label.textContent = 'Доп. стрелкам';

    const buy = document.createElement('button');
    buy.className = 'weapon__buy weapon__buy--ally';
    buy.type = 'button';
    buy.addEventListener('click', () => {
      this.meta.buyAllyWeapon(id);
      this.refreshUpgrades();
    });

    const done = document.createElement('div');
    done.className = 'weapon__owned weapon__owned--ally';
    done.textContent = 'Открыто';
    done.hidden = true;

    root.append(label, buy, done);
    this.allyAccessRows.set(id, { buy, done });
  }

  /**
   * Разметка строки ствола: иконка, название, характеристики, примечание, кнопка.
   *
   * Одна на магазин и на бустеры — строки отличаются только тем, что написано на
   * кнопке и что она делает, а собирать вторую такую же разметку значило бы
   * получить два ряда, расходящихся при первой же правке вёрстки.
   *
   * Тексты характеристик и примечания здесь НЕ проставляются: они зависят от
   * прокачки и ставятся перерисовкой (refreshWeaponStats), одной точкой для обоих
   * экранов.
   */
  private static buildWeaponRow(id: WeaponId): WeaponRow {
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
      badge.textContent = 'Особое';
      name.appendChild(badge);
    }

    const statsElement = document.createElement('div');
    statsElement.className = 'weapon__stats';

    const note = document.createElement('div');
    note.className = 'weapon__note';

    const buy = document.createElement('button');
    buy.className = 'weapon__buy';
    buy.type = 'button';

    // Подпись вместо кнопки у уже полученного ствола — по той же причине, что и
    // «Макс.» в строке прокачки: неактивная кнопка предлагала бы покупку, которой
    // не бывает. На экране бустеров она не показывается: там арендуют любой ствол,
    // открытый или нет, и кнопка всегда живая.
    const owned = document.createElement('div');
    owned.className = 'weapon__owned';
    owned.textContent = 'Получено';
    owned.hidden = true;

    // Оверлей замка — последним ребёнком: он absolute поверх всей строки и
    // должен рисоваться над остальным содержимым (см. .weapon__lock).
    const lock = document.createElement('div');
    lock.className = 'weapon__lock';
    lock.hidden = true;
    const lockIcon = document.createElement('div');
    lockIcon.className = 'weapon__lock-icon';
    lockIcon.textContent = '🔒';
    const lockText = document.createElement('div');
    lockText.className = 'weapon__lock-text';
    lock.append(lockIcon, lockText);

    row.append(icon, name, statsElement, note, buy, owned, lock);
    return { root: row, buy, stats: statsElement, note, owned, lock, lockText };
  }

  /**
   * Проставляет строке ствола числа и примечание по текущей прокачке.
   *
   * Одна точка на магазин и на бустеры: обе перерисовки зовут её, поэтому купить
   * уровень урона и увидеть в магазине прежние числа невозможно.
   *
   * showStats: false — экран бустеров. Урон и темп там не показываются: ствол в
   * аренду выбирают по тому, ЧТО это за оружие, а числа уже прочитаны в магазине,
   * где стволы и сравнивают между собой. Примечание особого остаётся: правило
   * «достаётся одному стрелку» решает выбор на этом экране, а не в магазине.
   *
   * Пустое примечание не оставляет пустой строки: у обычных стволов элемент
   * прячется целиком, иначе их ряды стали бы выше на пустую строку текста.
   */
  private static refreshWeaponStats(id: WeaponId, row: WeaponRow, showStats = true): void {
    row.stats.hidden = !showStats;
    if (showStats) row.stats.textContent = Screens.weaponStats(id);

    const note = Screens.weaponNote(id);
    row.note.textContent = note;
    row.note.hidden = note === '';
  }

  /**
   * Экран бустеров: строка бойцов и те же стволы, но в аренду на один забег
   * (см. MetaProgress, «Стартовый кит»).
   *
   * Пистолета здесь нет, в отличие от магазина: с него забег и так начинается,
   * и строка «купить то, что уже есть» была бы бессмысленной.
   */
  private buildBoosters(): void {
    const list = document.querySelector<HTMLElement>('#boosters-list');
    if (list === null) return;

    // Стартовая волна — первой строкой: она задаёт, ГДЕ начнётся вылазка,
    // остальные строки решают, с чем в неё выйти.
    list.appendChild(this.buildStartWaveRow());

    list.appendChild(this.buildBoosterShooterRow());

    // Бусты характеристик — сразу за бойцами, до стволов: предел отряда двигает
    // «до N» в строке бойцов и потому стоит рядом с ней, а остальные читаются
    // одним блоком разовых усилений. Порядок — STAT_BOOST_IDS.
    for (const id of STAT_BOOST_IDS) {
      list.appendChild(this.buildStatBoostRow(id));
    }

    for (const entry of shopWeapons()) {
      const row = Screens.buildWeaponRow(entry.id);
      row.buy.classList.add('weapon__buy--booster');
      row.buy.addEventListener('click', () => {
        // Повторное нажатие по выбранному снимает выбор: пока забег не начат,
        // набор — это намерение, и отменяется оно там же, где ставится.
        const picked =
          this.meta.startWeapon === entry.id || this.meta.startSpecialWeapon === entry.id;
        if (picked) this.meta.refundStartWeapon(entry.id);
        else this.meta.buyStartWeapon(entry.id);
        this.refreshBoosters();
      });
      this.boosterWeaponRows.set(entry.id, row);
      list.appendChild(row.root);
    }
  }

  /**
   * Строка стартовой волны: с какой волны начнётся вылазка. Кнопки как у
   * бойцов — волны берутся по шагу «на одну позже» и так же поштучно
   * возвращаются (итоговая цена линейная, см. MetaProgress.startWavePrice).
   */
  private buildStartWaveRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'weapon weapon--start-wave';

    const icon = document.createElement('div');
    icon.className = 'weapon__icon';
    icon.textContent = '⏩';

    const name = document.createElement('div');
    name.className = 'weapon__name';

    const stats = document.createElement('div');
    stats.className = 'weapon__stats';

    const actions = document.createElement('div');
    actions.className = 'weapon__actions';

    const refund = document.createElement('button');
    refund.className = 'weapon__buy weapon__buy--slim';
    refund.type = 'button';
    refund.textContent = '−';
    refund.setAttribute('aria-label', 'Начать на волну раньше');
    refund.addEventListener('click', () => {
      this.meta.refundStartWave();
      this.refreshBoosters();
    });

    const buy = document.createElement('button');
    buy.className = 'weapon__buy weapon__buy--booster';
    buy.type = 'button';
    buy.addEventListener('click', () => {
      this.meta.buyStartWave();
      this.refreshBoosters();
    });

    actions.append(refund, buy);
    row.append(icon, name, stats, actions);
    this.startWaveRow = { root: row, name, stats, buy, refund };
    return row;
  }

  /**
   * Строка бойцов. Как и у стартовой волны, ДВЕ денежные кнопки:
   * бойцы берутся по одному, и вернуть купленного нужно уметь так же поштучно.
   */
  private buildBoosterShooterRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'weapon weapon--booster-shooters';

    const icon = document.createElement('div');
    icon.className = 'weapon__icon';
    // Та же нарисованная фигурка, что над бочками со стрелками: боец должен
    // выглядеть одинаково везде, где его продают или роняют.
    icon.innerHTML = shootersIcon(1);

    const name = document.createElement('div');
    name.className = 'weapon__name';

    const stats = document.createElement('div');
    stats.className = 'weapon__stats';

    const actions = document.createElement('div');
    actions.className = 'weapon__actions';

    const refund = document.createElement('button');
    refund.className = 'weapon__buy weapon__buy--slim';
    refund.type = 'button';
    refund.textContent = '−';
    refund.setAttribute('aria-label', 'Вернуть стрелка');
    refund.addEventListener('click', () => {
      this.meta.refundStartShooter();
      this.refreshBoosters();
    });

    const buy = document.createElement('button');
    buy.className = 'weapon__buy weapon__buy--booster';
    buy.type = 'button';
    buy.addEventListener('click', () => {
      this.meta.buyStartShooter();
      this.refreshBoosters();
    });

    actions.append(refund, buy);
    row.append(icon, name, stats, actions);
    this.boosterShooterRow = { root: row, name, stats, buy, refund };
    return row;
  }

  /**
   * Строка буста характеристик.
   *
   * Каждый буст берётся один раз (задано пользователем, 2026-08-04; раньше
   * предел отряда складывался и носил вторую кнопку возврата, как бойцы).
   * Кнопка — переключатель: повторное нажатие («Убрать») снимает выбор, как у
   * строк аренды стволов.
   */
  private buildStatBoostRow(id: StatBoostId): HTMLElement {
    const row = document.createElement('div');
    row.className = 'weapon';

    const icon = document.createElement('div');
    icon.className = 'weapon__icon';
    icon.textContent = STAT_BOOST_VIEW[id].icon;

    const name = document.createElement('div');
    name.className = 'weapon__name';

    const stats = document.createElement('div');
    stats.className = 'weapon__stats';

    const buy = document.createElement('button');
    buy.className = 'weapon__buy weapon__buy--booster';
    buy.type = 'button';
    buy.addEventListener('click', () => {
      if (this.meta.startBoostCount(id) > 0) this.meta.refundStatBoost(id);
      else this.meta.buyStatBoost(id);
      this.refreshBoosters();
    });

    row.append(icon, name, stats, buy);
    this.statBoostRows.set(id, { root: row, name, stats, buy, refund: null });
    return row;
  }

  /**
   * Строка характеристик ствола: урон выстрела и выстрелы в минуту С УЧЁТОМ
   * ПРОКАЧКИ ГЕРОЯ.
   *
   * Показан набор ГЕРОЯ, а не стрелков: ствол из бочки достаётся всему отряду, но
   * числа двух ветвей разные, и выбирать надо было одну. Герой — тот боец,
   * которого игрок ведёт сам и по которому судит об оружии; у союзников урон к
   * тому же режется долей от героя (CONFIG.formation.allyDamageFactor), и их
   * числа читались бы как ослабленные.
   *
   * DPS убран: строка теперь пересчитывается прокачкой и с ним не влезала в
   * колонку (ЗАМЕРЕНО: колонка отдаёт 185 px).
   *
   * Минута, а не секунда, — как и в строках прокачки: у гранатомёта темп 0.6667
   * в секунду, и «0.7/с» о полутора секундах между выстрелами не говорит ничего.
   */
  private static weaponStats(id: WeaponId): string {
    // Урон до сотых, темп до десятых — как в строках прокачки (UpgradeValue.digits):
    // у огнемёта урон 0.36, и в десятых он превратился бы в «0.4».
    const damage = trimNumber(weaponDamage(id, 'hero'), 2);
    const perMinute = trimNumber(weaponFireRate(id, 'hero') * 60, 1);
    return `Урон ${damage} · ${perMinute}/мин`;
  }

  /**
   * Примечание особого ствола: чем именно он особый и что достаётся ОДНОМУ бойцу.
   *
   * Пустая строка — ствол обычный, примечания нет: у стрелковой лестницы всё
   * сказано уроном и темпом.
   *
   * Правило «одному бойцу» стоит в каждом из двух примечаний, а не отдельной
   * общей строкой: игрок читает строку того ствола, который покупает, и метка
   * «особое» у названия про количество носителей ничего не говорит. Реализация
   * правила — Squad.giveSpecialWeapon.
   */
  private static weaponNote(id: WeaponId): string {
    if (!isSpecialWeapon(id)) return '';

    const single = 'Достаётся одному стрелку.';

    if (id === 'flamethrower') {
      // Дальность огнемёта выводится из стрелковой (weaponRange), поэтому берётся
      // оттуда же, а не из таблицы: с прокачкой она уезжает.
      const range = trimNumber(weaponRange(id, 'hero'), 1);
      return `Сплошная струя, дальность вдвое короче — ${range} м. ${single}`;
    }

    if (id === 'grenadeLauncher') {
      // Урон взрыва — тем же порядком точности, что и урон выстрела: это тот же
      // урон, только по кругу.
      const blast = trimNumber(weaponBlastDamage(id, 'hero'), 2);
      const radius = trimNumber(weaponBlastRadius(id), 1);
      return `Взрыв на ${blast} HP в радиусе ${radius} м вокруг попадания. ${single}`;
    }

    return single;
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

    // Конфиг — к текущим уровням ПЕРЕД пересчётом строк: показания урона читают
    // из него общий множитель (player.squadDamageMultiplier), и без этого
    // купленный уровень «Общего урона» не двигал бы строки урона и магазина до
    // следующего забега. Заодно строки магазина (weaponStats — те же аксессоры)
    // перестают отставать и от покупок в ветках урона. applyTo идемпотентен,
    // а забега за экраном прокачки нет — фаза upgrade.
    this.meta.applyTo();

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

        const maxed = cost === null;

        row.name.textContent = `${UPGRADE_LABELS[id].title} (ур. ${level})`;
        // Вторая строка — фактическое состояние на купленном уровне, поэтому
        // обновляется здесь, а не проставляется один раз при сборке ряда.
        // У счётчика (размер отряда) показание считается из countValue, а не из
        // множителя, поэтому upgradeEffect его дать не может. Число — ВКЛЮЧАЯ
        // героя: это тот самый предел, что уходит в formation.maxShooters.
        row.effect.textContent = isCountUpgrade(id)
          ? `Макс. стрелков — ${this.meta.countValue(id, level)}`
          : (upgradeEffect(id, this.meta.multiplier(id, level)) ?? UPGRADE_LABELS[id].effect);
        // Третья строка — только следующий уровень; на максимуме вместо него
        // одно слово «Максимум»: достигнутое значение уже стоит строкой выше, и
        // повторять его здесь незачем.
        row.next.textContent = maxed ? 'Максимум' : this.nextText(id, level);

        // На последнем уровне кнопок нет вовсе — вместо них подпись «Макс.»:
        // нажимать больше не на что, и две неактивные кнопки только предлагали бы
        // покупку, которой не существует.
        row.buy.hidden = maxed;
        row.batch.hidden = maxed;
        row.maxed.hidden = !maxed;

        row.buy.textContent = `${cost ?? 0} EXP`;
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
   * Магазин: у каждой строки ровно четыре состояния — открыто, продаётся сейчас,
   * заперто предыдущим стволом, заперто недостигнутой волной. Ни одно не
   * прячется: игрок должен видеть всю цепочку, её стоимость и её условия наперёд.
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

      // Волна, до которой ещё не дошли, 0 — по волне ствол не заперт. У
      // полученного не спрашиваем вовсе: замок он уже прошёл.
      const waveLock = owned || this.meta.isWeaponWaveReached(id) ? 0 : weaponUnlockWave(id);

      // Числа ствола зависят от прокачки урона и темпа, а её покупают на соседней
      // вкладке этого же экрана — значит пересчитывать надо на каждой перерисовке.
      Screens.refreshWeaponStats(id, row);

      /*
       * ЗАМОК — ОВЕРЛЕЕМ поверх всей строки (решение пользователя,
       * 2026-08-03): иконка и условие разблокировки на размытом фоне, а не
       * замок на кнопке и причина в примечании. Условие цепочки называет
       * предыдущий ствол по имени; условие волны — волну, которую нужно
       * ПРОЙТИ, а не достичь (решение пользователя): «дойти до волны N» —
       * это пережить босса N − 1, и текст называет само действие. waveLock
       * здесь всегда ≥ 2 (без замка isWeaponWaveReached пропускает), так что
       * ниже волны 1 вычитание не уходит.
       */
      const chainLocked = !owned && !onSale;
      let lockText = '';
      if (waveLock > 0) {
        lockText = `Пройди волну ${waveLock - 1}`;
      } else if (chainLocked) {
        const list = shopWeapons();
        const prev = list[list.findIndex((entry) => entry.id === id) - 1];
        lockText = prev ? `Сначала открой ${WEAPON_NAMES[prev.id]}` : 'Пока недоступно';
      }
      row.lock.hidden = lockText === '';
      row.lockText.textContent = lockText;

      row.root.classList.toggle('weapon--owned', owned);
      row.root.classList.toggle('weapon--locked', chainLocked);

      // Полученное — подписью «Получено» вместо кнопки, и одинаково для купленного
      // и для стартового пистолета: игроку важно, что ствол у него есть, а не то,
      // достался он за деньги или сразу.
      row.buy.hidden = owned;
      row.owned.hidden = !owned;

      // Цена без замка: недоступность теперь показывает оверлей.
      if (!owned) row.buy.textContent = `${price} $`;
      row.buy.disabled = !canBuy;

      // Вторая цепочка — доступ доп. стрелков: та же логика состояний, что у
      // геройской кнопки строкой выше, но замок означает «сначала открой герою
      // или предыдущий доступ», а не волну — её уже прошла геройская покупка.
      const allyRow = this.allyAccessRows.get(id);
      if (allyRow !== undefined) {
        const allyOwned = this.meta.isAllyWeaponUnlocked(id);
        const allyNext = this.meta.nextAllyWeapon();
        const allyOnSale = owned && allyNext !== null && allyNext.id === id;
        const canBuyAlly = this.meta.canBuyAllyWeapon(id);
        ready ||= canBuyAlly;

        allyRow.buy.hidden = allyOwned;
        allyRow.done.hidden = !allyOwned;
        if (!allyOwned) {
          const allyPrice = this.meta.allyWeaponPrice(id);
          allyRow.buy.textContent = allyOnSale ? `${allyPrice} $` : `🔒 ${allyPrice} $`;
          allyRow.buy.disabled = !canBuyAlly;
        }
      }
    }

    this.tracks.get('weapons')?.tab.classList.toggle('upgrade-tab--ready', ready);
  }

  /**
   * Экран бустеров целиком: остаток денег, строка бойцов, строки аренды и итог
   * над кнопкой «В бой».
   *
   * Зовётся и при показе экрана, и после каждого нажатия на нём. Прокачку он не
   * трогает: экраны разные, и та перерисуется на своём показе — с уже
   * изменившимся остатком денег.
   */
  private refreshBoosters(): void {
    // Конфиг — к текущим уровням, как на прокачке (см. refreshUpgrades): после
    // забега с бустами в нём ещё лежат их множители, и примечания особых
    // стволов (дальность огнемёта, взрыв гранаты) показывали бы числа ×1.5.
    // Бусты нового кита от этого не страдают: их применит startRun, уже после.
    this.meta.applyTo();

    if (this.boostersMoney !== null) this.boostersMoney.textContent = `${this.meta.money} $`;

    this.refreshStartWave();
    this.refreshBoosterShooters();
    this.refreshStatBoosts();

    // Слота два — стрелковый и особый (см. MetaProgress.canBuyStartWeapon).
    const chosenFirearm = this.meta.startWeapon;
    const chosenSpecial = this.meta.startSpecialWeapon;
    for (const [id, row] of this.boosterWeaponRows) {
      const picked = chosenFirearm === id || chosenSpecial === id;
      // Замок доступности: стрелковое — по рекорду волны, особое — по первому
      // подбору из бочки (MetaProgress.isStartWeaponAvailable). Причина
      // пишется словами в примечание, как в магазине: замок на кнопке говорит
      // только «нельзя».
      const available = this.meta.isStartWeaponAvailable(id);

      // Без урона и темпа: на этом экране выбирают, ЧТО взять на забег, а не
      // сравнивают стволы по числам — для этого есть магазин.
      Screens.refreshWeaponStats(id, row, false);

      // Замок — оверлеем поверх строки, как в магазине (см. refreshWeapons):
      // стрелковое заперто цепочкой покупок — причина называет предыдущий
      // ствол, особое — первым подбором из бочки.
      let lockText = '';
      if (!available) {
        const list = shopWeapons();
        const prev = list[list.findIndex((entry) => entry.id === id) - 1];
        // Ствол назван по имени: содержимое строки под размытием не прочесть,
        // и «его» было бы не к чему отнести.
        lockText = isSpecialWeapon(id)
          ? `Подбери ${WEAPON_NAMES[id]} в вылазке`
          : `Сначала открой ${prev ? WEAPON_NAMES[prev.id] : 'предыдущий ствол'} в улучшениях`;
      }
      row.lock.hidden = lockText === '';
      row.lockText.textContent = lockText;

      row.root.classList.toggle('weapon--picked', picked);
      row.root.classList.toggle('weapon--locked', !available);

      const price = this.meta.startWeaponPrice(id);
      row.buy.textContent = picked ? 'Убрать' : `${price} $`;
      // Выбранный ствол остаётся нажимаемым: та же кнопка снимает выбор.
      // Остальные строки его типа canBuyStartWeapon гасит — замены выбором
      // другой строки нет, и по серым кнопкам одного типа видно, что оружие
      // ДРУГОГО типа выбирается отдельно и одновременно (при взятых бойцах).
      row.buy.disabled = !picked && !this.meta.canBuyStartWeapon(id);
    }

    this.refreshBoosterSummary();
  }

  /**
   * Строка стартовой волны: выбранная волна, открытый предел и цена шага.
   *
   * Пока старт не открыт вовсе (рекорд ниже 2 + unlockAhead), вместо предела
   * стоит условие словами — «Пройди волну 3»: замок здесь без оверлея, как
   * у бустов, — скрывать размытием в строке нечего. Формулировка «пройди»,
   * а не «дойди до» (решение пользователя): дойти до волны 2 + unlockAhead —
   * это пережить босса волны 1 + unlockAhead, текст называет само действие.
   */
  private refreshStartWave(): void {
    const row = this.startWaveRow;
    if (row === null) return;

    const wave = this.meta.startWave;
    const limit = this.meta.startWaveLimit;
    const { unlockAhead } = CONFIG.shop.startBonuses.startWave;

    // Выбранная волна — в названии, как число бойцов у стрелков: это то же
    // «сколько уже куплено», и искать его игрок будет там же.
    row.name.textContent = wave > 1 ? `Стартовая волна · ${wave}` : 'Стартовая волна';
    // «до N» — самый поздний открытый старт: волна W открывается рекордом
    // W + unlockAhead (MetaProgress.startWaveLimit).
    row.stats.textContent =
      limit > 1 ? `Начать с волны · до ${limit}` : `Пройди волну ${1 + unlockAhead}`;
    row.root.classList.toggle('weapon--picked', wave > 1);

    row.buy.textContent = `${this.meta.startWavePrice} $`;
    row.buy.disabled = !this.meta.canBuyStartWave();
    if (row.refund !== null) row.refund.disabled = wave <= 1;
  }

  /** Строка бойцов: сколько взято, сколько можно и почём. */
  private refreshBoosterShooters(): void {
    const row = this.boosterShooterRow;
    if (row === null) return;

    const count = this.meta.startShooters;
    const limit = this.meta.startShooterLimit;
    const price = this.meta.startShooterPrice;

    // Число взятых — в названии, как уровень у улучшений: это то же «сколько
    // уже куплено», и искать его игрок будет там же.
    row.name.textContent = count > 0 ? `Доп. стрелок ×${count}` : 'Доп. стрелок';
    // Коротко до предела: колонка здесь на 40 px уже, чем в магазине (место
    // забрала вторая кнопка). ЗАМЕРЕНО canvas-обмером при фактическом шрифте:
    // колонка отдаёт 145 px, «в отряд на забег · до 22» занимало 129, а
    // «в отряд на забег · не больше 2» — 167, и строка переносилась на вторую,
    // отчего ряд стрелков был выше оружейных. «В отряд на вылазку» длиннее
    // прежнего на одно слово — замер перепроверен ниже, в браузере.
    // Предел показывается ВКЛЮЧАЯ героя — как «Макс. стрелков» на вкладке
    // прокачки: числа отряда везде считаются с основным. Купить можно на
    // одного меньше (limit): место героя не продаётся.
    row.stats.textContent = `В отряд на вылазку · до ${limit + 1}`;
    row.root.classList.toggle('weapon--picked', count > 0);

    row.buy.textContent = `${price} $`;
    row.buy.disabled = !this.meta.canBuyStartShooter();
    if (row.refund !== null) row.refund.disabled = count === 0;
  }

  /**
   * Строки бустов характеристик: подписи, цены и доступность.
   *
   * Вторая строка предела отряда называет итоговый предел ПОСЛЕ буста, а не
   * потолок конфига: буст один, и «до 28» на недокупленной ветке обещал бы
   * места, которых одна покупка не даёт.
   */
  private refreshStatBoosts(): void {
    const { multiplier, shooterStep, shooterCap } = CONFIG.shop.startBonuses.statBoosts;
    const percent = trimNumber((multiplier - 1) * 100, 0);

    for (const [id, row] of this.statBoostRows) {
      const count = this.meta.startBoostCount(id);
      const price = this.meta.statBoostPrice(id);
      const { title, note } = STAT_BOOST_VIEW[id];

      row.root.classList.toggle('weapon--picked', count > 0);
      row.name.textContent = id === 'shooters' ? title : `${title} +${percent}%`;
      if (id === 'shooters') {
        const target = Math.min(this.meta.countValue('squadSize') + shooterStep, shooterCap);
        row.stats.textContent = `+${shooterStep} к стрелкам · до ${target}`;
      } else {
        row.stats.textContent = note;
      }
      row.buy.textContent = count > 0 ? 'Убрать' : `${price} $`;
      row.buy.disabled = count === 0 && !this.meta.canBuyStatBoost(id);
    }
  }

  /**
   * Сводка «В забег: …» над кнопкой «В бой».
   *
   * Дублирует то, что и так обведено жёлтым в списке, и это намеренно: список
   * может не поместиться в экран целиком, а нажатие уносит в забег без второго
   * подтверждения. Пустой набор строку скрывает — иначе она отъедала бы высоту у
   * тех, кто бустерами не пользуется.
   */
  private refreshBoosterSummary(): void {
    if (this.boostersSummary === null) return;

    const parts: string[] = [];

    // Стартовая волна — первой, как и её строка в списке: она говорит, где
    // начнётся вылазка, остальное — с чем.
    const startWave = this.meta.startWave;
    if (startWave > 1) parts.push(`старт с ${startWave}-й волны`);

    const shooters = this.meta.startShooters;
    if (shooters > 0) {
      // Считая героя: «4 стрелка» — отряд на старте забега, а не число покупок.
      // Числа стрелков в отряде везде показываются с основным.
      const total = shooters + 1;
      parts.push(`${total} ${plural(total, 'стрелок', 'стрелка', 'стрелков')}`);
    }

    const weapon = this.meta.startWeapon;
    if (weapon !== null) parts.push(WEAPON_NAMES[weapon]);

    const special = this.meta.startSpecialWeapon;
    if (special !== null) parts.push(WEAPON_NAMES[special]);

    // Бусты — после стволов, в порядке своих строк. Предел отряда — итоговым
    // числом («отряд до 28»), а не прибавкой: сводку пересчитывают глазами
    // перед боем, и итог здесь полезнее слагаемых.
    const percent = trimNumber((CONFIG.shop.startBonuses.statBoosts.multiplier - 1) * 100, 0);
    for (const id of STAT_BOOST_IDS) {
      if (this.meta.startBoostCount(id) === 0) continue;
      if (id === 'shooters') parts.push(`отряд до ${this.meta.boostedMaxShooters}`);
      else parts.push(`${STAT_BOOST_VIEW[id].title.toLowerCase()} +${percent}%`);
    }

    this.boostersSummary.hidden = parts.length === 0;
    this.boostersSummary.textContent = `В вылазку: ${parts.join(' · ')}`;
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
   * Третья строка: во что превратится характеристика на СЛЕДУЮЩЕМ уровне —
   * «Сл. ур.: 2.5 HP».
   *
   * Только следующее значение, без текущего: текущее стоит строкой выше словами
   * («Базовый урон — 2.4 HP»), и повторять его здесь стрелкой значило бы дважды
   * писать одно число в двух строках подряд.
   *
   * На максимальном уровне вместо этого стоит «Максимум» (см. refreshUpgrades):
   * следующего уровня не существует, а достигнутое видно второй строкой.
   */
  private nextText(id: UpgradeId, level: number): string {
    return `Сл. ур.: ${this.valueText(id, level + 1)}${this.unitText(id)}`;
  }

  /**
   * Значение улучшения на заданном уровне.
   *
   * У боевых характеристик это ФАКТИЧЕСКОЕ число (урон выстрела, выстрелы в
   * минуту, метры, проценты поглощения, hp в секунду, секунды задержки), а не
   * множитель: см. UpgradeValue в meta.ts. Округление до десятых — везде одно, и
   * его следствие стоит держать в уме: прибавка уровня к урону пистолета (4% от
   * 1.0) в десятых не видна, зато видна к дальности и темпу.
   *
   * Улучшения-счётчики (размер отряда) считаются в бойцах, поэтому у них «3»
   * без знака умножения: «×1.33» о размере отряда не сказало бы ничего. Опыт,
   * деньги и общий урон показываются надбавкой в процентах («+22%»), в одном
   * языке со второй строкой («+20% за вылазку», «+20% ко всему урону»):
   * фактическое число у них зависит не от уровня, а от забега или от ствола в
   * руках, поэтому вместо числа — прибавка.
   */
  private valueText(id: UpgradeId, level: number): string {
    if (isCountUpgrade(id)) return `${this.meta.countValue(id, level)}`;

    const actual = upgradeValue(id, this.meta.multiplier(id, level));
    if (actual !== null) return trimNumber(actual.value, actual.digits);

    return `+${trimNumber((this.meta.multiplier(id, level) - 1) * 100, 1)}%`;
  }

  /** Единица фактического значения; пустая строка — значение без единицы. */
  private unitText(id: UpgradeId): string {
    return upgradeValue(id, this.meta.multiplier(id))?.unit ?? '';
  }

  private toggle(element: HTMLElement | null, visible: boolean): void {
    if (element === null) return;
    element.classList.toggle('visible', visible);
  }
}
