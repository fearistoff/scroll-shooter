import { CONFIG } from '../config';
import {
  isSpecialWeapon,
  shopWeapons,
  weaponUnlockWave,
  type ShooterKind,
  type ShopWeapon,
  type WeaponId,
} from '../entities/weapons';

/** Ключи улучшений. Совпадают с ключами CONFIG.meta.upgrades. */
export type UpgradeId =
  | 'heroDamage'
  | 'heroFireRate'
  | 'heroRange'
  | 'heroDamageTaken'
  | 'heroHp'
  | 'heroRegenRate'
  | 'heroRegenDelay'
  | 'squadSize'
  | 'allyDamage'
  | 'allyFireRate'
  | 'allyRange'
  | 'allyDamageTaken'
  | 'allyHp'
  | 'allyRegenRate'
  | 'allyRegenDelay'
  | 'exp'
  | 'money';

/**
 * Описание улучшения из CONFIG.meta.upgrades в едином виде.
 *
 * Тип выписан руками, а не выведен из конфига: набор полей у улучшений разный
 * (свой costGrowth у веток регенерации, base/step у счётчиков), и обращение к
 * такому полю по ключу-объединению иначе не проходит проверку типов.
 * Необязательные поля читаются только там, где они по смыслу есть.
 */
interface UpgradeSpec {
  maxLevel: number;
  baseCost: number;
  /** Прибавка множителя за уровень, % от базы. У счётчиков её нет. */
  stepPercent?: number;
  /** Знаменатель прогрессии цены. Нет — берётся общий CONFIG.meta.costGrowth. */
  costGrowth?: number;
  /** Счётчики: значение на нулевом уровне и прибавка за уровень. */
  base?: number;
  step?: number;
}

/** Вкладка экрана прокачки: кого качаем. */
export type UpgradeTrackId = 'hero' | 'ally' | 'common';

export interface UpgradeTrack {
  id: UpgradeTrackId;
  /** Подпись на кнопке таббара. Коротко: три вкладки делят ширину экрана. */
  title: string;
  ids: readonly UpgradeId[];
}

/**
 * Ветки прокачки. Боевые характеристики существуют в двух экземплярах — свой
 * набор у главного героя и свой у доп. стрелков, — и качаются независимо.
 *
 * Опыт, деньги и размер отряда вынесены в третью вкладку, а не приписаны к одной
 * из двух: ничто из этого не является характеристикой стрелка. Опыт и деньги
 * относятся к забегу целиком, размер отряда — к отряду, а не к бойцу в нём: он
 * одинаково меняет и число союзников, и то, сколько всего стволов у игрока.
 * Приписать такое герою значило бы, что «вкладка героя» — это на самом деле
 * «герой и ещё экономика».
 *
 * Порядок вкладок и строк внутри них берётся отсюда: экран собирает разметку по
 * этому списку, руками там ничего не размечено.
 */
export const UPGRADE_TRACKS: readonly UpgradeTrack[] = [
  {
    id: 'hero',
    title: 'Герой',
    // Здоровье стоит после защиты: обе ветки про живучесть, и рядом они читаются
    // как пара «меньше получать — больше выдерживать».
    ids: ['heroDamage', 'heroFireRate', 'heroRange', 'heroDamageTaken', 'heroHp', 'heroRegenRate', 'heroRegenDelay'],
  },
  {
    id: 'ally',
    title: 'Стрелки',
    ids: ['allyDamage', 'allyFireRate', 'allyRange', 'allyDamageTaken', 'allyHp', 'allyRegenRate', 'allyRegenDelay'],
  },
  {
    id: 'common',
    title: 'Прочее',
    // Размер отряда стоит первым: он решает, скольким бойцам достанутся строки
    // вкладки стрелков, то есть покупается раньше них.
    // Опыт и деньги стоят рядом: это две валюты игры, и качаются они одинаково.
    ids: ['squadSize', 'exp', 'money'],
  },
];

/** Плоский список всех улучшений — для сохранения, сброса и отладки. */
export const UPGRADE_IDS: readonly UpgradeId[] = UPGRADE_TRACKS.flatMap((track) => track.ids);

interface UpgradeLabel {
  title: string;
  effect: string;
}

/**
 * Подписи БОЕВЫХ характеристик — одни на обе ветки.
 *
 * Ветки героя и стрелков состоят из одних и тех же шести характеристик, поэтому
 * и названия, и описания у них общие: кого качаем, сказано вкладкой, и повторять
 * это в каждой строке значит гонять по экрану лишние слова. Формулировки поэтому
 * безличные («скорость лечения», а не «скорость лечения героя») — одна и та же
 * строка показывается на обеих вкладках.
 *
 * Ключи — характеристика без приставки; UPGRADE_LABELS ниже раздаёт их обеим
 * веткам ссылкой на один объект, так что разойтись они уже не могут.
 */
const COMBAT_LABELS = {
  // effect у боевых характеристик — запасной текст: обычно на его месте стоит
  // ФАКТИЧЕСКОЕ состояние («Базовый урон — 2.4 HP», см. upgradeEffect), и
  // показывается он только если значение почему-то не посчиталось.
  damage: { title: 'Урон', effect: 'Урон выстрела пистолета' },
  fireRate: { title: 'Скорострельность', effect: 'Выстрелов в минуту' },
  range: { title: 'Дальность', effect: 'Расстояние, которое проходит пуля' },
  damageTaken: { title: 'Защита', effect: 'Сколько урона поглощается' },
  hp: { title: 'Здоровье', effect: 'Полный запас HP бойца' },
  regenRate: { title: 'Восст. HP', effect: 'Скорость лечения' },
  regenDelay: { title: 'Пауза лечения', effect: 'Пауза перед началом лечения' },
} as const satisfies Record<string, UpgradeLabel>;

/** Человеческие названия и описание эффекта — для экрана прокачки. */
export const UPGRADE_LABELS: Record<UpgradeId, UpgradeLabel> = {
  heroDamage: COMBAT_LABELS.damage,
  heroFireRate: COMBAT_LABELS.fireRate,
  heroRange: COMBAT_LABELS.range,
  heroDamageTaken: COMBAT_LABELS.damageTaken,
  heroHp: COMBAT_LABELS.hp,
  heroRegenRate: COMBAT_LABELS.regenRate,
  heroRegenDelay: COMBAT_LABELS.regenDelay,

  allyDamage: COMBAT_LABELS.damage,
  allyFireRate: COMBAT_LABELS.fireRate,
  allyRange: COMBAT_LABELS.range,
  allyDamageTaken: COMBAT_LABELS.damageTaken,
  allyHp: COMBAT_LABELS.hp,
  allyRegenRate: COMBAT_LABELS.regenRate,
  allyRegenDelay: COMBAT_LABELS.regenDelay,

  // Единственное улучшение-счётчик: в строке стоит не множитель, а «3 → 4».
  // effect здесь, как и у боевых, запасной: обычно на его месте фактическое
  // состояние — «Макс. стрелков — 3» и «+20% за вылазку» (см. upgradeEffect и
  // Screens.refreshUpgrades).
  squadSize: { title: 'Размер отряда', effect: 'Макс. стрелков в отряде' },
  exp: { title: 'Опыт', effect: 'Надбавка за вылазку' },
  money: { title: 'Деньги', effect: 'Надбавка за вылазку' },
};

/**
 * ФАКТИЧЕСКОЕ ЗНАЧЕНИЕ характеристики на экране прокачки: число и его единица.
 *
 * Экран показывает не множитель, а то, во что он превращается — «132.0 выстр./мин»
 * вместо «×1.00». Множитель сам по себе не говорит ничего: 4% к чему именно и
 * сколько это в бою — видно только из настоящего числа.
 *
 * unit клеится к числу как есть, поэтому у процентов он без ведущего пробела:
 * «1.0%», но «16.1 м».
 */
export interface UpgradeValue {
  value: number;
  unit: string;
  /**
   * Сколько знаков после запятой ЗНАЧИМЫ. Хвост нулей всё равно обрезается
   * (см. Screens.trim), поэтому это потолок точности, а не формат.
   *
   * У урона 2: база пистолета — 1 hp, шаг уровня 4%, и в десятых прибавка не
   * видна вовсе. У остальных 1: там числа крупные (132 выстрела в минуту, 16 м),
   * и вторая цифра после запятой уже шум.
   */
  digits: number;
}

/**
 * Как получить фактическое значение из множителя ветки.
 *
 * БАЗА БЕРЁТСЯ ИЗ КОНФИГА КАЖДЫЙ РАЗ, а не запоминается: числа оружия и
 * регенерации крутятся на живой игре, и снимок разошёлся бы с боем.
 *
 * Пистолет — мерка урона, темпа и дальности: он стартовый и единственный ствол,
 * который есть у бойца всегда. Прочие стволы показывают свои числа сами, в
 * строках магазина (Screens.weaponStats).
 *
 * kind нужен ОДНОМУ урону: союзник бьёт долей от героя
 * (CONFIG.formation.allyDamageFactor), и без этой доли строка на вкладке
 * стрелков обещала бы втрое больше, чем боец наносит. Темп, дальность, защита и
 * лечение у союзника считаются от той же базы, что у героя, — разница только в
 * множителе его собственной ветки.
 */
function combatValue(
  kind: ShooterKind,
  stat: keyof typeof COMBAT_LABELS,
  multiplier: number,
): UpgradeValue {
  const { weapons, player, formation } = CONFIG;

  switch (stat) {
    case 'damage': {
      const factor = kind === 'ally' ? formation.allyDamageFactor : 1;
      return { value: weapons.pistol.damage * multiplier * factor, unit: ' HP', digits: 2 };
    }
    // Выстрелов в МИНУТУ: в секунду у пистолета выходит 2.2, и на таком числе
    // прибавка уровня (4%) не читается вовсе.
    case 'fireRate':
      return { value: weapons.pistol.fireRate * multiplier * 60, unit: '/мин', digits: 1 };
    // 1 unit = 1 метр (см. CLAUDE.md, «Единицы и оси»), поэтому дальность
    // показывается как есть.
    case 'range':
      return { value: weapons.pistol.range * multiplier, unit: ' м', digits: 1 };
    // Множитель здесь — доля ДОХОДЯЩЕГО урона (0.99 на первом уровне), а игрока
    // интересует поглощённая часть: её и показываем.
    case 'damageTaken':
      return { value: (1 - multiplier) * 100, unit: '%', digits: 1 };
    // Здоровье — единственная боевая характеристика с РАЗНОЙ базой у героя и
    // союзника (100 против 30 HP): множитель у веток одинаковый по потолку
    // (×3.00), а числа на экране обязаны совпадать с полосками в бою.
    case 'hp': {
      const base = kind === 'ally' ? player.allyHp : player.heroHp;
      return { value: base * multiplier, unit: ' HP', digits: 1 };
    }
    // Регенерация задана как «hpPerInterval за intervalSeconds», а в бою работает
    // ровно как их отношение (Squad.regenerate), — значит и показывать надо его.
    case 'regenRate': {
      const { hpPerInterval, intervalSeconds } = player.regen;
      const perSecond = intervalSeconds > 0 ? hpPerInterval / intervalSeconds : 0;
      return { value: perSecond * multiplier, unit: ' HP/с', digits: 1 };
    }
    case 'regenDelay':
      return { value: player.regen.delayAfterDamageSeconds * multiplier, unit: ' с', digits: 1 };
  }
}

/**
 * Что за характеристику качает улучшение и чью. null — улучшение не боевое
 * (размер отряда, опыт, деньги): у них фактического значения в этом смысле нет,
 * и экран показывает их по-прежнему — счётчиком или множителем.
 */
const COMBAT_STATS: Partial<
  Record<UpgradeId, { kind: ShooterKind; stat: keyof typeof COMBAT_LABELS }>
> = {
  heroDamage: { kind: 'hero', stat: 'damage' },
  heroFireRate: { kind: 'hero', stat: 'fireRate' },
  heroRange: { kind: 'hero', stat: 'range' },
  heroDamageTaken: { kind: 'hero', stat: 'damageTaken' },
  heroHp: { kind: 'hero', stat: 'hp' },
  heroRegenRate: { kind: 'hero', stat: 'regenRate' },
  heroRegenDelay: { kind: 'hero', stat: 'regenDelay' },

  allyDamage: { kind: 'ally', stat: 'damage' },
  allyFireRate: { kind: 'ally', stat: 'fireRate' },
  allyRange: { kind: 'ally', stat: 'range' },
  allyDamageTaken: { kind: 'ally', stat: 'damageTaken' },
  allyHp: { kind: 'ally', stat: 'hp' },
  allyRegenRate: { kind: 'ally', stat: 'regenRate' },
  allyRegenDelay: { kind: 'ally', stat: 'regenDelay' },
};

/**
 * Фактическое значение боевой характеристики при заданном множителе ветки.
 * null — улучшение не боевое (см. COMBAT_STATS).
 *
 * Множитель передаётся, а не берётся из прогресса: экран показывает и текущий
 * уровень, и следующий, то есть значение нужно считать для любого уровня, а не
 * только для купленного.
 */
export function upgradeValue(id: UpgradeId, multiplier: number): UpgradeValue | null {
  const entry = COMBAT_STATS[id];
  if (entry === undefined) return null;
  return combatValue(entry.kind, entry.stat, multiplier);
}

/**
 * Число без хвоста нулей: 132.0 → «132», 1.10 → «1.1», 1.04 → «1.04».
 *
 * Ровные значения должны выглядеть ровными: «132.0 выстрела» и «10.0 с» читаются
 * как измеренные с точностью до десятых, хотя это просто целые числа. Точность
 * приходит снаружи (digits у UpgradeValue): у урона сотые, у остального десятые.
 *
 * Лежит здесь, рядом с самими значениями и их точностью, а не на экране: единица
 * измерения, число знаков и формат — одно решение, и разносить его по файлам
 * значит однажды показать «2.40 HP» в одном месте и «2.4 HP» в другом.
 */
export function trimNumber(value: number, digits: number): string {
  return String(+value.toFixed(digits));
}

/**
 * Форма слова при числе: 1 выстрел, 2 выстрела, 5 выстрелов.
 *
 * У дробных числительных форма всегда как у 2–4 («133.3 выстрела»), поэтому
 * нецелое значение сразу берёт few.
 */
function pluralize(value: number, one: string, few: string, many: string): string {
  if (!Number.isInteger(value)) return few;

  const tens = Math.abs(value) % 100;
  if (tens >= 11 && tens <= 14) return many;

  const units = Math.abs(value) % 10;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/**
 * Вторая строка ряда: ФАКТИЧЕСКОЕ состояние характеристики словами — «Базовый
 * урон — 2.4 HP», «132 выстрела в минуту».
 *
 * Не описание того, что улучшение делает, а показание прибора: описание игрок
 * прочитал один раз, а число смотрит каждый заход на экран. Считается по
 * КУПЛЕННОМУ уровню; что даст следующий, стоит третьей строкой.
 *
 * null — улучшение-счётчик (размер отряда): его показание считается не из
 * множителя, а из countValue, и собирает его экран (Screens.refreshUpgrades).
 */
export function upgradeEffect(id: UpgradeId, multiplier: number): string | null {
  // Опыт и деньги — не боевые, но показание у них тоже есть: текущая надбавка
  // к добыче. «+20% за вылазку», а не «×1.20»: прибавка в процентах читается
  // сразу, множитель требует пересчёта в уме.
  if (id === 'exp' || id === 'money') {
    return `+${trimNumber((multiplier - 1) * 100, 1)}% за вылазку`;
  }

  const entry = COMBAT_STATS[id];
  if (entry === undefined) return null;

  const { value, digits } = combatValue(entry.kind, entry.stat, multiplier);
  const shown = trimNumber(value, digits);
  const rounded = +value.toFixed(digits);

  switch (entry.stat) {
    case 'damage':
      return `Базовый урон — ${shown} HP`;
    case 'fireRate':
      return `${shown} ${pluralize(rounded, 'выстрел', 'выстрела', 'выстрелов')} в минуту`;
    case 'range':
      return `Пуля пролетает ${shown} м`;
    case 'damageTaken':
      return `Поглощается ${shown}% урона`;
    case 'hp':
      return `Запас здоровья — ${shown} HP`;
    case 'regenRate':
      return `Восстанавливается ${shown} HP/с`;
    case 'regenDelay':
      return `Лечение начинается через ${shown} с`;
  }
}

/**
 * Улучшения, которые множитель УМЕНЬШАЮТ, а не увеличивают. Список, а не
 * проверка имени по подстроке: подстрока сломалась бы на первом же улучшении,
 * в названии которого случайно окажется «Taken».
 */
const REDUCING_UPGRADES: ReadonlySet<UpgradeId> = new Set<UpgradeId>([
  'heroDamageTaken',
  'allyDamageTaken',
  // Задержку перед лечением прокачка сокращает: чем меньше, тем лучше игроку.
  'heroRegenDelay',
  'allyRegenDelay',
]);

/** true — уровни этого улучшения множитель снижают (урон, задержка лечения). */
export function isReducingUpgrade(id: UpgradeId): boolean {
  return REDUCING_UPGRADES.has(id);
}

/**
 * Улучшения-СЧЁТЧИКИ: уровень даёт не процент, а целую единицу (сейчас — бойца
 * в отряд). Значение считается как base + step × level, множителя у них нет.
 *
 * Список, а не признак «в конфиге есть поле base»: так исключение видно в одном
 * месте, и опечатка в конфиге не превращает боевое улучшение в счётчик молча.
 */
const COUNT_UPGRADES: ReadonlySet<UpgradeId> = new Set<UpgradeId>(['squadSize']);

/** true — улучшение измеряется штуками, а не множителем (см. COUNT_UPGRADES). */
export function isCountUpgrade(id: UpgradeId): boolean {
  return COUNT_UPGRADES.has(id);
}

/**
 * Ключи из сохранений версии с ЕДИНЫМ набором улучшений на весь отряд, и куда
 * они переезжают. Уровень старой ветки получают ОБЕ новые — иначе разделение
 * стало бы скрытым нерфом: раньше одна покупка усиливала и героя, и союзников,
 * а после переноса в одну ветку союзники внезапно откатились бы к нулю.
 */
const LEGACY_UPGRADE_IDS: Readonly<Record<string, readonly UpgradeId[]>> = {
  damage: ['heroDamage', 'allyDamage'],
  fireRate: ['heroFireRate', 'allyFireRate'],
  range: ['heroRange', 'allyRange'],
  damageTaken: ['heroDamageTaken', 'allyDamageTaken'],
  // exp ключ не сменил — читается общим циклом нового формата.
};

interface SavedProgress {
  levels: Partial<Record<UpgradeId, number>>;
  bank: number;
  /** Банк денег — вторая валюта, за неё открывается оружие. */
  money: number;
  /**
   * Сколько стволов цепочки магазина открыто. Число, а не список ключей:
   * покупать можно только следующий по порядку, поэтому открытый набор — всегда
   * ПРЕФИКС CONFIG.shop.weapons, а у префикса всё содержание в его длине.
   * Заодно последовательность нельзя нарушить правкой сохранения руками.
   */
  weapons: number;
  /**
   * Открытый доп. стрелкам префикс той же цепочки. Поля нет в сохранениях до
   * появления доступа стрелков; на чтении зажимается геройским префиксом.
   */
  allyWeapons: number;
  /**
   * Стартовый кит: оплачен, но ещё не выдан. Лежит в сохранении, а не только в
   * памяти, потому что деньги за него сняты, — иначе перезагрузка страницы между
   * покупкой и забегом съедала бы покупку.
   */
  startShooters: number;
  /**
   * Стрелковый ствол кита. До появления второго слота ключ был единственным и
   * мог держать особый ствол — loadStartKit такой раскладывает по-новому.
   */
  startWeapon: WeaponId | null;
  /** Особое оружие кита — второй слот. Поля нет в сохранениях до его появления. */
  startSpecial: WeaponId | null;
  /**
   * Особое, подобранное из бочки хоть раз, — открывает его аренду в бустерах.
   * Поля нет в старых сохранениях: такой игрок открывает аренду особого заново
   * первым же подбором.
   */
  specialsPicked: WeaponId[];
  /**
   * Рекорд достигнутой волны. Поля нет в сохранениях, сделанных до появления
   * замка по волне: такой игрок начинает рекорд с нуля и открывает средние
   * ступени магазина заново — уже купленное при этом остаётся купленным
   * (weapons — отдельное поле).
   */
  bestWave: number;
}

/**
 * Мета-прогрессия между забегами (ТЗ раздел 11).
 *
 * Держит уровни улучшений и банк EXP, считает цены, продаёт уровни,
 * сохраняется в localStorage и применяет результат к CONFIG.
 *
 * Улучшения разложены по веткам (UPGRADE_TRACKS): свой набор боевых
 * характеристик у главного героя, свой у доп. стрелков, опыт общий. Сам класс о
 * ветках не знает — для него это просто плоский список ключей; деление нужно
 * только экрану прокачки и applyTo().
 *
 * Улучшения затрагивают ТОЛЬКО характеристики игрока — множители урона, темпа,
 * дальности, получаемого урона, опыта, объёма находки денег и предел размера
 * отряда. Скорость мира, расстановка бочек и ворот, состав зомби от уровней не
 * зависят: множитель денег меняет ЧИСЛО на монете, а не то, с кого она падает.
 *
 * У размера отряда есть косвенные следствия в мире, и их стоит держать в уме:
 * бочка со стрелками не спавнится при полном отряде, а поток зомби ускоряется от
 * числа стволов (enemies.spawn.squadScale). То есть эта ветка — единственная,
 * которая заодно поднимает сложность.
 *
 * applyTo() записывает множители ЦЕЛИКОМ, абсолютным значением. Поэтому вызывать
 * его можно сколько угодно раз — накопления не будет, и снимок исходного конфига
 * не нужен.
 */
export class MetaProgress {
  private readonly levels = new Map<UpgradeId, number>();
  private bankValue = 0;
  private moneyValue = 0;
  /** Длина открытого префикса CONFIG.shop.weapons — см. SavedProgress.weapons. */
  private weaponsBought = 0;
  /**
   * Сколько стволов той же цепочки открыто ДОП. СТРЕЛКАМ. Тоже префикс, и
   * всегда не длиннее геройского: доступ стрелкам продаётся только к уже
   * открытому герою (CONFIG.shop.allyWeaponPriceDivisor).
   */
  private allyWeaponsBought = 0;
  /** Оплаченные бойцы стартового кита — см. «Стартовый кит» ниже. */
  private startShootersValue = 0;
  /** Оплаченный стрелковый ствол кита. null — забег начнётся с пистолета. */
  private startWeaponValue: WeaponId | null = null;
  /** Оплаченное особое оружие кита — второй слот, см. canBuyStartWeapon. */
  private startSpecialValue: WeaponId | null = null;
  /** Рекорд достигнутой волны за всё время — см. «Магазин оружия» ниже. */
  private bestWaveValue = 0;
  /**
   * Особое оружие, подобранное из бочки хоть раз за всё время. Открывает его
   * аренду в бустерах (isStartWeaponAvailable): пока ствол ни разу не был в
   * руках, предлагать его в кит нечего.
   */
  private readonly specialsPicked = new Set<WeaponId>();

  constructor() {
    this.load();
  }

  /** Накопленный EXP. Дробный: множитель опыта даёт нецелые кристаллы. */
  get bank(): number {
    return this.bankValue;
  }

  /** Для показа на экране: дробную часть не отображаем, но и не теряем. */
  get bankDisplay(): number {
    return Math.floor(this.bankValue);
  }

  level(id: UpgradeId): number {
    return this.levels.get(id) ?? 0;
  }

  maxLevel(id: UpgradeId): number {
    return CONFIG.meta.upgrades[id].maxLevel;
  }

  isMaxed(id: UpgradeId): boolean {
    return this.level(id) >= this.maxLevel(id);
  }

  /** Описание улучшения из конфига (см. UpgradeSpec — почему тип выписан руками). */
  private spec(id: UpgradeId): UpgradeSpec {
    return CONFIG.meta.upgrades[id];
  }

  /**
   * Знаменатель прогрессии цены у конкретного улучшения: своё поле, если задано,
   * иначе общий CONFIG.meta.costGrowth.
   *
   * Своё нужно веткам с другим числом уровней: цена последнего уровня — это
   * baseCost × costGrowth^(maxLevel−1), и при 15 уровнях вместо 50 общий
   * знаменатель дал бы совсем другой потолок цены.
   */
  private costGrowth(id: UpgradeId): number {
    return this.spec(id).costGrowth ?? CONFIG.meta.costGrowth;
  }

  /**
   * Цена СЛЕДУЮЩЕГО уровня: baseCost × costGrowth^level.
   * Экспонента даёт дешёвое начало и дорогой хвост: первые уровни берутся
   * десятками за забег, последние стоят десятки забегов.
   * null — уровень уже максимальный.
   */
  nextCost(id: UpgradeId): number | null {
    if (this.isMaxed(id)) return null;
    const { baseCost } = CONFIG.meta.upgrades[id];
    return Math.round(baseCost * this.costGrowth(id) ** this.level(id));
  }

  canBuy(id: UpgradeId): boolean {
    const cost = this.nextCost(id);
    return cost !== null && this.bankValue >= cost;
  }

  /** Покупает один уровень. Возвращает true, если покупка прошла. */
  buy(id: UpgradeId): boolean {
    const cost = this.nextCost(id);
    if (cost === null || this.bankValue < cost) return false;

    this.bankValue -= cost;
    this.levels.set(id, this.level(id) + 1);
    this.save();
    return true;
  }

  /**
   * Сколько уровней реально возьмёт кнопка «пачкой»: сколько успеет оплатить
   * банк, но не больше limit. Считается тем же экспоненциальным шагом цены, что
   * и покупка, — иначе подпись на кнопке разошлась бы с результатом нажатия.
   */
  affordableLevels(id: UpgradeId, limit = CONFIG.meta.batchSize): number {
    let count = 0;
    let bank = this.bankValue;
    let level = this.level(id);
    const { baseCost, maxLevel } = CONFIG.meta.upgrades[id];
    const growth = this.costGrowth(id);

    while (count < limit && level < maxLevel) {
      const cost = Math.round(baseCost * growth ** level);
      if (bank < cost) break;
      bank -= cost;
      level++;
      count++;
    }

    return count;
  }

  /**
   * Покупает до count уровней подряд, пока хватает EXP и есть куда расти.
   * Возвращает, сколько уровней куплено. Нужна на поздних уровнях: жать кнопку
   * по одному разу пятьдесят раз невыносимо.
   */
  buyBatch(id: UpgradeId, count = CONFIG.meta.batchSize): number {
    let bought = 0;
    while (bought < count) {
      const cost = this.nextCost(id);
      if (cost === null || this.bankValue < cost) break;
      this.bankValue -= cost;
      this.levels.set(id, this.level(id) + 1);
      bought++;
    }

    if (bought > 0) this.save();
    return bought;
  }

  /** Зачисляет EXP забега в банк. */
  deposit(amount: number): void {
    if (amount <= 0) return;
    this.bankValue += amount;
    this.save();
  }

  // --- Магазин оружия (за деньги) -------------------------------------------

  /*
   * Вторая половина мета-прогрессии, и она устроена иначе, чем улучшения выше:
   * не уровни за EXP, а разовые покупки за деньги (CONFIG.money). Купленный
   * ствол не выдаётся в руки — он получает право ВЫПАДАТЬ из бочек на забеге
   * (см. WeaponUnlocks в barrels.ts). До первой покупки у отряда только
   * пистолет, и бочек с оружием на забеге нет вовсе.
   *
   * Покупка строго последовательная, поэтому открытое хранится длиной префикса,
   * а не набором ключей: непоследовательное состояние просто нечем выразить.
   *
   * У СРЕДНИХ СТУПЕНЕЙ ЕСТЬ ВТОРОЕ УСЛОВИЕ, кроме денег: автомат и пулемёт не
   * продаются, пока игрок ни разу не дошёл до своей волны (3-й и 5-й
   * соответственно). Требование задано в CONFIG.run.unlocks.weapons тем же
   * числом, которым заперто выпадение ступени из бочек, — открывать ствол,
   * которому ещё негде выпасть, незачем. Рекорд волны копится в bestWave и
   * растёт только вверх: неудачная вылазка уже открытого не отбирает.
   */

  /**
   * Рекорд достигнутой волны за всё время. 0 — вылазок ещё не было.
   *
   * Единственное в мета-прогрессии, что не покупается, а зарабатывается игрой:
   * по нему открываются средние ступени магазина. Сбросом прогресса стирается
   * вместе с остальным — иначе «как в первый раз» не получилось бы.
   */
  get bestWave(): number {
    return this.bestWaveValue;
  }

  /**
   * Запоминает волну законченной вылазки. Зовётся из Game.finishRun один раз за
   * забег; РЕКОРД ТОЛЬКО РАСТЁТ, поэтому порядок вызовов значения не имеет.
   */
  registerWave(wave: number): void {
    if (wave <= this.bestWaveValue) return;
    this.bestWaveValue = wave;
    this.save();
  }

  /**
   * Дошёл ли игрок до волны, с которой ствол продаётся.
   *
   * Ствол без замка (weaponUnlockWave === 1) проходит проверку ВСЕГДА, а не
   * сравнением с рекордом: первая волна есть в любой вылазке, но у игрока,
   * который ни одной ещё не закончил, рекорд равен нулю, и сравнение заперло бы
   * ему пистолет-пулемёт.
   */
  isWeaponWaveReached(id: WeaponId): boolean {
    const need = weaponUnlockWave(id);
    return need <= 1 || this.bestWaveValue >= need;
  }

  /**
   * Стволы, чей замок по волне закрывает ИМЕННО ЭТА вылазка: рекорд ещё не
   * дотягивал до их волны, а достигнутая дотягивает. Нужно экрану результата —
   * «что открылось за вылазку».
   *
   * Считается ДО registerWave, иначе рекорд уже поднят и разницы не видно.
   * Уже открытые стволы отбрасываются: в сохранениях, сделанных до появления
   * замка по волне, автомат и пулемёт могли быть куплены раньше.
   *
   * Стволы без замка (need <= 1) отбрасываются отдельным условием, а не
   * сравнением с рекордом: при рекорде 0 условие «1 > 0» верно для каждого из
   * них, и первая же вылазка объявляла бы «открылось» про весь магазин.
   */
  weaponsOpenedByWave(wave: number): WeaponId[] {
    return shopWeapons()
      .map((entry) => entry.id)
      .filter((id) => {
        const need = weaponUnlockWave(id);
        if (need <= 1 || this.isWeaponUnlocked(id)) return false;
        return need > this.bestWaveValue && need <= wave;
      });
  }

  /** Накопленные деньги. Целые: находка округляется на выпадении. */
  get money(): number {
    return this.moneyValue;
  }

  /** Зачисляет деньги забега. */
  depositMoney(amount: number): void {
    if (amount <= 0) return;
    this.moneyValue += amount;
    this.save();
  }

  /** Сколько стволов магазина уже открыто. */
  get weaponsUnlockedCount(): number {
    return this.weaponsBought;
  }

  /**
   * Открыт ли ствол. Пистолет открыт всегда — он стартовый и в магазине не
   * продаётся; всё, чего нет в списке магазина, тоже считается открытым, иначе
   * добавление ствола мимо магазина молча выключило бы его из игры.
   */
  isWeaponUnlocked(id: WeaponId): boolean {
    const index = shopWeapons().findIndex((entry) => entry.id === id);
    return index < 0 || index < this.weaponsBought;
  }

  /** Следующая покупка в цепочке. null — открыто уже всё. */
  nextWeapon(): ShopWeapon | null {
    return shopWeapons()[this.weaponsBought] ?? null;
  }

  /** Цена ствола из списка магазина. null — такого в магазине нет. */
  weaponPrice(id: WeaponId): number | null {
    return shopWeapons().find((entry) => entry.id === id)?.price ?? null;
  }

  /**
   * Можно ли купить прямо сейчас: это следующий по очереди, рекорд волны дотянул
   * до его замка и денег хватает.
   */
  canBuyWeapon(id: WeaponId): boolean {
    const next = this.nextWeapon();
    if (next === null || next.id !== id) return false;
    return this.isWeaponWaveReached(id) && this.moneyValue >= next.price;
  }

  /**
   * Покупает ствол. Возвращает true, если покупка прошла.
   *
   * Проверка «это именно следующий» стоит здесь, а не только в интерфейсе:
   * порядок — правило магазина, и обойти его вызовом из отладочной консоли
   * нельзя так же, как нельзя купить уровень без EXP.
   */
  buyWeapon(id: WeaponId): boolean {
    if (!this.canBuyWeapon(id)) return false;

    this.moneyValue -= this.nextWeapon()!.price;
    this.weaponsBought++;
    this.save();
    return true;
  }

  // --- Доступ доп. стрелков к оружию (вторая цепочка магазина) ---------------

  /*
   * Открытие герою разрешает стволу выпадать из бочек, но при подборе он
   * достаётся только герою; доступ стрелков покупается отдельно, втрое дешевле
   * и только после геройского (обоснование — CONFIG.shop.allyWeaponPriceDivisor).
   * Эффект применяет Squad.allyWeaponFor: стрелок без доступа получает лучшую
   * открытую ему ступень не выше подобранной.
   */

  /** Сколько стволов открыто доп. стрелкам. */
  get allyWeaponsUnlockedCount(): number {
    return this.allyWeaponsBought;
  }

  /**
   * Открыт ли ствол доп. стрелкам. Вне магазина (пистолет) — открыт всем, по
   * той же причине, что в isWeaponUnlocked.
   */
  isAllyWeaponUnlocked(id: WeaponId): boolean {
    const index = shopWeapons().findIndex((entry) => entry.id === id);
    return index < 0 || index < this.allyWeaponsBought;
  }

  /** Следующий ствол цепочки доступа стрелков. null — открыто всё. */
  nextAllyWeapon(): ShopWeapon | null {
    return shopWeapons()[this.allyWeaponsBought] ?? null;
  }

  /** Цена доступа стрелков: треть цены открытия герою. null — нет в магазине. */
  allyWeaponPrice(id: WeaponId): number | null {
    const price = this.weaponPrice(id);
    if (price === null) return null;
    return Math.round(price / CONFIG.shop.allyWeaponPriceDivisor);
  }

  /**
   * Можно ли открыть стрелкам прямо сейчас: следующий в их цепочке, герою уже
   * открыт и денег хватает. Замок по волне второй раз не спрашивается — его
   * уже прошла геройская покупка.
   */
  canBuyAllyWeapon(id: WeaponId): boolean {
    const next = this.nextAllyWeapon();
    if (next === null || next.id !== id) return false;
    if (!this.isWeaponUnlocked(id)) return false;
    return this.moneyValue >= this.allyWeaponPrice(id)!;
  }

  /** Открывает ствол стрелкам. Порядок цепочки, как и в buyWeapon, — правило магазина. */
  buyAllyWeapon(id: WeaponId): boolean {
    if (!this.canBuyAllyWeapon(id)) return false;

    this.moneyValue -= this.allyWeaponPrice(id)!;
    this.allyWeaponsBought++;
    this.save();
    return true;
  }

  /**
   * Отметка «особое подобрано из бочки»: зовёт BarrelField при фактической
   * выдаче ствола бойцу (WeaponUnlocks.markSpecialPicked). Стрелковые сюда не
   * попадают — их аренда открывается рекордом волны, а не подбором.
   */
  markSpecialPicked(id: WeaponId): void {
    if (this.specialsPicked.has(id)) return;
    this.specialsPicked.add(id);
    this.save();
  }

  /** Подбирал ли игрок это особое хоть раз. */
  wasSpecialPicked(id: WeaponId): boolean {
    return this.specialsPicked.has(id);
  }

  // --- Стартовый кит, он же «Бустеры» (за деньги, на один забег) -------------

  /*
   * Третья форма покупки и единственная ОДНОРАЗОВАЯ: оплаченные бойцы и ствол
   * выдаются отряду в начале ближайшего забега и вместе с ним пропадают
   * (CONFIG.shop.startBonuses — там же цены и почему они такие). Игроку это
   * показано отдельным экраном перед забегом — «Бустеры» (см. Screens).
   *
   * Деньги снимаются сразу, а не на старте забега: кит лежит в сохранении, и за
   * него уже заплачено. Пока забег не начат, любую покупку можно отменить с
   * полным возвратом — до выдачи кит остаётся набором намерений, а не тратой, и
   * промах пальцем не должен стоить полутора забегов дохода.
   */

  /** Сколько бойцов оплачено на старт ближайшего забега. */
  get startShooters(): number {
    return this.startShootersValue;
  }

  /** Оплаченный на старт стрелковый ствол. null — забег начнётся с пистолета. */
  get startWeapon(): WeaponId | null {
    return this.startWeaponValue;
  }

  /** Оплаченное на старт особое оружие. null — особый слот пуст. */
  get startSpecialWeapon(): WeaponId | null {
    return this.startSpecialValue;
  }

  /** Цена одного бойца в кит. */
  get startShooterPrice(): number {
    return CONFIG.shop.startBonuses.shooterPrice;
  }

  /**
   * Сколько бойцов вообще можно взять: все места отряда, кроме места героя.
   * Предел тот же, которым обрежет выдачу Squad.addShooters, поэтому оплатить
   * бойца, которому не хватит места в строю, нельзя.
   *
   * Считается по УРОВНЮ ветки размера отряда, а не по
   * CONFIG.formation.maxShooters: в конфиг уровень переносит applyTo(), а он
   * вызывается только на старте забега. Купленный на экране прокачки уровень
   * до этого момента в конфиге не виден, и экран бустеров показывал бы старый
   * предел. Расхождения с выдачей нет: к моменту, когда Squad.addShooters
   * читает конфиг, applyTo() уже вызван (Game.startRun).
   */
  get startShooterLimit(): number {
    return Math.max(0, this.countValue('squadSize') - 1);
  }

  canBuyStartShooter(): boolean {
    return (
      this.startShootersValue < this.startShooterLimit &&
      this.moneyValue >= this.startShooterPrice
    );
  }

  buyStartShooter(): boolean {
    if (!this.canBuyStartShooter()) return false;

    this.moneyValue -= this.startShooterPrice;
    this.startShootersValue++;
    this.save();
    return true;
  }

  /** Возвращает одного оплаченного бойца в кошелёк. */
  refundStartShooter(): boolean {
    if (this.startShootersValue <= 0) return false;

    this.startShootersValue--;
    this.moneyValue += this.startShooterPrice;
    // Пара стволов держится на доп. стрелках (см. canBuyStartWeapon): вернули
    // последнего — стрелковый слот возвращается тоже, с полными деньгами.
    // Именно стрелковый: особое остаётся герою, а общий ствол без бойцов
    // не достался бы никому.
    if (
      this.startShootersValue === 0 &&
      this.startSpecialValue !== null &&
      this.startWeaponValue !== null
    ) {
      this.moneyValue += this.startWeaponPrice(this.startWeaponValue) ?? 0;
      this.startWeaponValue = null;
    }
    this.save();
    return true;
  }

  /**
   * Цена ствола на один забег: доля от цены его открытия в магазине.
   * null — ствола нет в магазине (пистолет: он и так стартовый).
   */
  startWeaponPrice(id: WeaponId): number | null {
    const price = this.weaponPrice(id);
    if (price === null) return null;
    return Math.round(price / CONFIG.shop.startBonuses.weaponPriceDivisor);
  }

  /** Слот кита, в который ложится этот ствол: особые и стрелковые не смешиваются. */
  private startSlot(id: WeaponId): WeaponId | null {
    return isSpecialWeapon(id) ? this.startSpecialValue : this.startWeaponValue;
  }

  /** Соседний слот — оружие ДРУГОГО типа, уже взятое в кит. */
  private otherStartSlot(id: WeaponId): WeaponId | null {
    return isSpecialWeapon(id) ? this.startWeaponValue : this.startSpecialValue;
  }

  /**
   * Доступен ли ствол для аренды в кит (решение пользователя, 2026-08-03).
   *
   * СТРЕЛКОВОЕ — по цепочке ПОКУПОК магазина: арендуется всё купленное плюс
   * СЛЕДУЮЩАЯ ступень. Ничего не куплено — доступен один пистолет-пулемёт,
   * куплен ПП — открывается аренда автомата, куплен автомат — пулемёта.
   * Аренда так остаётся витриной ровно одной ещё не купленной ступени.
   * Рекорд волны здесь не спрашивается — он остаётся условием ПОКУПКИ
   * следующей ступени (canBuyWeapon), а не её аренды.
   *
   * ОСОБОЕ — только после первого ПОДБОРА из бочки (markSpecialPicked): в
   * магазине улучшений оно продаётся сразу, а в кит не предлагается, пока
   * игрок ни разу не держал его в руках. «Следующая ступень» на особое не
   * распространяется: после покупки всего стрелкового nextWeapon указывает
   * на огнемёт, но его аренду открывает подбор, а не очередь.
   */
  isStartWeaponAvailable(id: WeaponId): boolean {
    if (isSpecialWeapon(id)) return this.specialsPicked.has(id);
    return this.isWeaponUnlocked(id) || this.nextWeapon()?.id === id;
  }

  /**
   * Можно ли взять ствол в кит.
   *
   * Открытость в магазине не требуется, но доступность — да
   * (isStartWeaponAvailable): стрелковое по рекорду волны, особое по первому
   * подбору.
   *
   * Слотов в ките ДВА — стрелковый и особый, по одному на тип. Занятый слот
   * своего типа блокирует покупку целиком: замены выбором другой строки нет,
   * сначала «Убрать» (Screens.refreshBoosters гасит такие строки — по серым
   * кнопкам одного типа видно, что второй тип выбирается отдельно и
   * одновременно).
   *
   * ПАРА «особое + стрелковое» осмысленна только с доп. стрелками: особое на
   * старте уйдёт герою, стрелковое — общий ствол остальных, и без бойцов ему
   * некому достаться. Поэтому второй тип открывается, когда в ките есть хотя бы
   * один боец (см. также refundStartShooter — возврат последнего бойца пару
   * расцепляет).
   */
  canBuyStartWeapon(id: WeaponId): boolean {
    const price = this.startWeaponPrice(id);
    if (price === null) return false;
    if (!this.isStartWeaponAvailable(id)) return false;
    if (this.startSlot(id) !== null) return false;
    if (this.otherStartSlot(id) !== null && this.startShootersValue === 0) return false;
    return this.moneyValue >= price;
  }

  /** Берёт ствол в свой слот кита. */
  buyStartWeapon(id: WeaponId): boolean {
    if (!this.canBuyStartWeapon(id)) return false;

    this.moneyValue -= this.startWeaponPrice(id)!;
    if (isSpecialWeapon(id)) this.startSpecialValue = id;
    else this.startWeaponValue = id;
    this.save();
    return true;
  }

  /** Снимает ствол с кита с полным возвратом денег. */
  refundStartWeapon(id: WeaponId): boolean {
    if (this.startSlot(id) !== id) return false;

    this.moneyValue += this.startWeaponPrice(id) ?? 0;
    if (isSpecialWeapon(id)) this.startSpecialValue = null;
    else this.startWeaponValue = null;
    this.save();
    return true;
  }

  /** Стоимость содержимого кита по текущим ценам аренды. */
  private startKitWorth(): number {
    let worth = this.startShootersValue * this.startShooterPrice;
    if (this.startWeaponValue !== null) {
      worth += this.startWeaponPrice(this.startWeaponValue) ?? 0;
    }
    if (this.startSpecialValue !== null) {
      worth += this.startWeaponPrice(this.startSpecialValue) ?? 0;
    }
    return worth;
  }

  /**
   * Возвращает весь кит в кошелёк и чистит его.
   *
   * Выбор бустеров живёт, только пока открыт их экран (решение пользователя,
   * 2026-08-03): уход с экрана назад — отмена всего набора с полным возвратом.
   * Зовёт Game.openUpgrade — это единственный путь с бустеров, кроме боя.
   */
  refundStartKit(): void {
    if (!this.hasStartKit) return;

    this.moneyValue += this.startKitWorth();
    this.startShootersValue = 0;
    this.startWeaponValue = null;
    this.startSpecialValue = null;
    this.save();
  }

  /** Есть ли что выдать отряду на старте забега. */
  get hasStartKit(): boolean {
    return (
      this.startShootersValue > 0 ||
      this.startWeaponValue !== null ||
      this.startSpecialValue !== null
    );
  }

  /**
   * Хватает ли денег хоть на один бустер. По этому признаку Game решает, стоит
   * ли вообще показывать экран перед забегом: без денег он предлагал бы одни
   * недоступные кнопки, то есть был бы лишним нажатием по дороге в бой.
   *
   * Спрашивается теми же предикатами, что стоят на кнопках, а не сравнением с
   * самой дешёвой ценой: правила покупки живут в одном месте и разойтись с
   * условием показа не могут.
   */
  get hasAffordableBooster(): boolean {
    if (this.canBuyStartShooter()) return true;
    return shopWeapons().some((entry) => this.canBuyStartWeapon(entry.id));
  }

  /**
   * Отдаёт кит и очищает его: покупка одноразовая, и списывается она здесь, а
   * не при оплате, — иначе прерванный запуск игры терял бы оплаченное.
   *
   * Зовётся из Game.startRun ровно один раз за забег.
   */
  consumeStartKit(): { shooters: number; weapon: WeaponId | null; special: WeaponId | null } {
    const kit = {
      shooters: this.startShootersValue,
      weapon: this.startWeaponValue,
      special: this.startSpecialValue,
    };
    if (!this.hasStartKit) return kit;

    this.startShootersValue = 0;
    this.startWeaponValue = null;
    this.startSpecialValue = null;
    this.save();
    return kit;
  }

  /**
   * Итоговый множитель улучшения — то, что попадёт в конфиг.
   *
   * level задаётся явно, когда нужен не текущий множитель, а следующий: экран
   * прокачки показывает «×1.04 → ×1.08», и считать шаг он должен той же
   * формулой, а не своей.
   *
   * У счётчиков (isCountUpgrade) stepPercent нет, и здесь они дадут ×1 —
   * множителя у них не существует, спрашивать надо countValue.
   */
  multiplier(id: UpgradeId, level = this.level(id)): number {
    const step = ((this.spec(id).stepPercent ?? 0) / 100) * level;
    // Получаемый урон единственное, что уменьшается.
    return isReducingUpgrade(id) ? 1 - step : 1 + step;
  }

  /**
   * Значение улучшения-счётчика в штуках: база плюс уровень. Для множителей
   * вернёт 0 — у них нет ни base, ни step.
   */
  countValue(id: UpgradeId, level = this.level(id)): number {
    const spec = this.spec(id);
    return (spec.base ?? 0) + (spec.step ?? 0) * level;
  }

  /**
   * Переносит прогресс в конфиг. Значения записываются целиком, поэтому вызов
   * идемпотентен: применить дважды — то же, что применить один раз.
   *
   * Наборов множителей два — герой и доп. стрелки, — и они не пересекаются:
   * ветка героя пишет только в heroMultipliers, ветка стрелков только в
   * allyMultipliers. Опыт один на забег, поэтому лежит рядом, а не в наборе.
   */
  applyTo(config: typeof CONFIG = CONFIG): void {
    config.player.heroMultipliers.damageMultiplier = this.multiplier('heroDamage');
    config.player.heroMultipliers.fireRateMultiplier = this.multiplier('heroFireRate');
    config.player.heroMultipliers.rangeMultiplier = this.multiplier('heroRange');
    config.player.heroMultipliers.damageTakenMultiplier = this.multiplier('heroDamageTaken');
    config.player.heroMultipliers.hpMultiplier = this.multiplier('heroHp');
    config.player.heroMultipliers.regenRateMultiplier = this.multiplier('heroRegenRate');
    config.player.heroMultipliers.regenDelayMultiplier = this.multiplier('heroRegenDelay');

    config.player.allyMultipliers.damageMultiplier = this.multiplier('allyDamage');
    config.player.allyMultipliers.fireRateMultiplier = this.multiplier('allyFireRate');
    config.player.allyMultipliers.rangeMultiplier = this.multiplier('allyRange');
    config.player.allyMultipliers.damageTakenMultiplier = this.multiplier('allyDamageTaken');
    config.player.allyMultipliers.hpMultiplier = this.multiplier('allyHp');
    config.player.allyMultipliers.regenRateMultiplier = this.multiplier('allyRegenRate');
    config.player.allyMultipliers.regenDelayMultiplier = this.multiplier('allyRegenDelay');

    config.player.expMultiplier = this.multiplier('exp');
    config.player.moneyMultiplier = this.multiplier('money');

    // Размер отряда — единственное, что прокачка пишет ВНЕ player: предел живёт
    // в formation, потому что его читают все источники бойцов через
    // Squad.addShooters. Значение абсолютное, как и множители, поэтому повторный
    // applyTo ничего не накапливает. Пул капсул союзников от него не зависит —
    // он рассчитан на визуальный потолок строя, — так что покупка уровня прямо
    // на экране прокачки безопасна и действует со следующего забега.
    config.formation.maxShooters = this.countValue('squadSize');
  }

  /**
   * Есть ли что сбрасывать. По этому признаку экран прокачки прячет кнопку
   * сброса: на чистом сохранении она предлагала бы стереть ноль.
   *
   * Спрашивается ровно то, что чистит reset(), — купленный уровень, любая из
   * двух валют, открытый ствол, оплаченный стартовый кит. Достаточно одного:
   * игрок, накопивший EXP, но ничего не купивший, тоже потеряет прогресс. Кит
   * учитывается по той же причине: игрок, спустивший все деньги на бойцов, иначе
   * увидел бы «сбрасывать нечего» — и всё равно потерял бы их при сбросе.
   */
  get hasProgress(): boolean {
    if (this.bankValue > 0 || this.moneyValue > 0 || this.weaponsBought > 0) return true;
    if (this.hasStartKit) return true;
    for (const level of this.levels.values()) {
      if (level > 0) return true;
    }
    return false;
  }

  /**
   * Сбрасывает прогресс целиком (кнопка на экране прокачки) — вместе с деньгами
   * и открытым оружием: после сброса игра начинается с пистолета, как в первый
   * раз, иначе «сброс» оставлял бы половину прогрессии на месте.
   */
  reset(): void {
    this.levels.clear();
    this.bankValue = 0;
    this.moneyValue = 0;
    this.weaponsBought = 0;
    this.allyWeaponsBought = 0;
    this.startShootersValue = 0;
    this.startWeaponValue = null;
    this.startSpecialValue = null;
    this.specialsPicked.clear();
    this.bestWaveValue = 0;
    this.save();
    this.applyTo();
  }

  // --- Сохранение -----------------------------------------------------------

  /**
   * Чтение сохранения. Битое, чужое или урезанное сохранение не должно ломать
   * запуск: любое отклонение от ожидаемого — начинаем с нуля.
   */
  private load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(CONFIG.meta.storageKey);
    } catch {
      // localStorage может быть недоступен (приватный режим, отключён политикой).
      return;
    }
    if (raw === null) return;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;

      const saved = parsed as Partial<SavedProgress>;

      if (typeof saved.bank === 'number' && Number.isFinite(saved.bank) && saved.bank >= 0) {
        this.bankValue = saved.bank;
      }

      // Денег и оружия нет в сохранениях, сделанных до появления магазина:
      // такой игрок начинает магазин с нуля, а уровни улучшений сохраняет.
      if (typeof saved.money === 'number' && Number.isFinite(saved.money) && saved.money >= 0) {
        this.moneyValue = Math.floor(saved.money);
      }

      if (typeof saved.weapons === 'number' && Number.isFinite(saved.weapons)) {
        // Зажимаем длиной цепочки: список магазина мог укоротиться с прошлой версии.
        this.weaponsBought = Math.min(Math.max(Math.floor(saved.weapons), 0), shopWeapons().length);
      }

      if (typeof saved.allyWeapons === 'number' && Number.isFinite(saved.allyWeapons)) {
        // Зажимается геройским префиксом, а не длиной списка: доступ стрелков
        // не может обгонять открытое герою (правка сохранения руками).
        this.allyWeaponsBought = Math.min(
          Math.max(Math.floor(saved.allyWeapons), 0),
          this.weaponsBought,
        );
      }

      if (typeof saved.bestWave === 'number' && Number.isFinite(saved.bestWave)) {
        this.bestWaveValue = Math.max(Math.floor(saved.bestWave), 0);
      }

      if (Array.isArray(saved.specialsPicked)) {
        for (const id of saved.specialsPicked) {
          // Только настоящие особые: правка руками или сменившийся список не
          // должны открывать аренду стрелкового мимо замка по волне.
          if (typeof id === 'string' && isSpecialWeapon(id as WeaponId)) {
            this.specialsPicked.add(id as WeaponId);
          }
        }
      }

      if (typeof saved.levels === 'object' && saved.levels !== null) {
        for (const id of UPGRADE_IDS) {
          const value = saved.levels[id];
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          this.levels.set(id, this.clampLevel(id, value));
        }

        this.migrateLegacy(saved.levels as Record<string, unknown>);
      }

      // Кит читается ПОСЛЕДНИМ: его предел зависит от уровня размера отряда, а
      // тот прочитан строкой выше.
      this.loadStartKit(saved);

      /*
       * КИТ НЕ ПЕРЕЖИВАЕТ ПЕРЕЗАГРУЗКУ: выбор бустеров живёт, пока открыт их
       * экран (см. refundStartKit). В сохранении он остаётся только затем,
       * чтобы закрытая вкладка не съела уже снятые деньги: здесь содержимое
       * возвращается в кошелёк по текущим ценам аренды. Нарочно БЕЗ save() —
       * load не должен писать; повторная загрузка того же сохранения
       * конвертирует кит так же, а первый же save() зафиксирует результат.
       */
      if (this.hasStartKit) {
        this.moneyValue += this.startKitWorth();
        this.startShootersValue = 0;
        this.startWeaponValue = null;
        this.startSpecialValue = null;
      }
    } catch {
      // Невалидный JSON — просто стартуем с нуля.
      this.levels.clear();
      this.bankValue = 0;
      this.moneyValue = 0;
      this.weaponsBought = 0;
      this.allyWeaponsBought = 0;
      this.startShootersValue = 0;
      this.startWeaponValue = null;
      this.startSpecialValue = null;
      this.specialsPicked.clear();
      this.bestWaveValue = 0;
    }
  }

  /**
   * Стартовый кит из сохранения.
   *
   * Предел бойцов — startShooterLimit: он считается по уровню ветки размера
   * отряда и потому верен и здесь, до первого applyTo() (см. комментарий у
   * геттера).
   *
   * Ствол проверяется по списку магазина — по нему считается цена аренды, и
   * незнакомый ключ (правка сохранения руками, укоротившийся список) остался бы
   * без неё. Открытость при этом не спрашивается: арендовать можно и закрытое.
   */
  private loadStartKit(saved: Partial<SavedProgress>): void {
    if (typeof saved.startShooters === 'number' && Number.isFinite(saved.startShooters)) {
      const limit = this.startShooterLimit;
      this.startShootersValue = Math.min(Math.max(Math.floor(saved.startShooters), 0), limit);
    }

    const inShop = (id: WeaponId): boolean => shopWeapons().some((entry) => entry.id === id);

    // Особый слот — новый формат; в него принимается только особый ствол.
    if (typeof saved.startSpecial === 'string') {
      const id = saved.startSpecial as WeaponId;
      if (inShop(id) && isSpecialWeapon(id)) this.startSpecialValue = id;
    }

    // Ключ startWeapon остался от времени, когда слот был один и держал любой
    // ствол: особый из старого сохранения переезжает в свой слот.
    if (typeof saved.startWeapon === 'string') {
      const id = saved.startWeapon as WeaponId;
      if (inShop(id)) {
        if (!isSpecialWeapon(id)) this.startWeaponValue = id;
        else if (this.startSpecialValue === null) this.startSpecialValue = id;
      }
    }

    // Пара стволов без доп. стрелков честным путём не собирается (см.
    // canBuyStartWeapon) — это правка сохранения руками. Стрелковый слот
    // очищается без возврата: неизвестно, были ли за него плачены деньги.
    if (
      this.startShootersValue === 0 &&
      this.startSpecialValue !== null &&
      this.startWeaponValue !== null
    ) {
      this.startWeaponValue = null;
    }
  }

  /**
   * Зажимает уровень в допустимый диапазон: сохранение могло быть от версии
   * с другим maxLevel или отредактировано вручную.
   */
  private clampLevel(id: UpgradeId, value: number): number {
    return Math.min(Math.max(Math.floor(value), 0), this.maxLevel(id));
  }

  /**
   * Сохранение из версии с ЕДИНЫМ набором улучшений на весь отряд: раскладывает
   * старые ключи по обеим новым веткам (см. LEGACY_UPGRADE_IDS).
   *
   * Ключ localStorage при разделении веток не менялся, поэтому в файле могут
   * лежать оба формата разом — например, если игрок успел зайти в прокачку уже
   * на новой версии. Новый формат главнее: уже прочитанную ветку перенос не
   * трогает, иначе он затирал бы свежие покупки старым числом.
   */
  private migrateLegacy(levels: Record<string, unknown>): void {
    for (const [legacyId, targets] of Object.entries(LEGACY_UPGRADE_IDS)) {
      const value = levels[legacyId];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      for (const id of targets) {
        if (this.levels.has(id)) continue;
        this.levels.set(id, this.clampLevel(id, value));
      }
    }
  }

  private save(): void {
    const payload: SavedProgress = {
      levels: {},
      bank: this.bankValue,
      money: this.moneyValue,
      weapons: this.weaponsBought,
      allyWeapons: this.allyWeaponsBought,
      startShooters: this.startShootersValue,
      startWeapon: this.startWeaponValue,
      startSpecial: this.startSpecialValue,
      specialsPicked: [...this.specialsPicked],
      bestWave: this.bestWaveValue,
    };
    for (const id of UPGRADE_IDS) {
      const level = this.level(id);
      if (level > 0) payload.levels[id] = level;
    }

    try {
      localStorage.setItem(CONFIG.meta.storageKey, JSON.stringify(payload));
    } catch {
      // Нет места или доступа — прогресс останется только в памяти сессии.
    }
  }

  /** Состояние прогресса — для отладки и проверок. */
  debugSnapshot(): {
    bank: number;
    money: number;
    bestWave: number;
    weapons: WeaponId[];
    allyWeapons: WeaponId[];
    nextWeapon: ShopWeapon | null;
    startKit: {
      shooters: number;
      limit: number;
      weapon: WeaponId | null;
      special: WeaponId | null;
    };
    specialsPicked: WeaponId[];
    levels: Record<string, number>;
    multipliers: Record<string, number>;
    nextCosts: Record<string, number | null>;
  } {
    const levels: Record<string, number> = {};
    const multipliers: Record<string, number> = {};
    const nextCosts: Record<string, number | null> = {};

    for (const id of UPGRADE_IDS) {
      levels[id] = this.level(id);
      multipliers[id] = +this.multiplier(id).toFixed(4);
      nextCosts[id] = this.nextCost(id);
    }

    return {
      bank: +this.bankValue.toFixed(2),
      money: this.moneyValue,
      bestWave: this.bestWaveValue,
      weapons: shopWeapons()
        .slice(0, this.weaponsBought)
        .map((entry) => entry.id),
      allyWeapons: shopWeapons()
        .slice(0, this.allyWeaponsBought)
        .map((entry) => entry.id),
      nextWeapon: this.nextWeapon(),
      startKit: {
        shooters: this.startShootersValue,
        limit: this.startShooterLimit,
        weapon: this.startWeaponValue,
        special: this.startSpecialValue,
      },
      specialsPicked: [...this.specialsPicked],
      levels,
      multipliers,
      nextCosts,
    };
  }
}
