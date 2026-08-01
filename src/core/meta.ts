import { CONFIG } from '../config';

/** Ключи улучшений. Совпадают с ключами CONFIG.meta.upgrades. */
export type UpgradeId =
  | 'heroDamage'
  | 'heroFireRate'
  | 'heroRange'
  | 'heroDamageTaken'
  | 'heroRegenRate'
  | 'heroRegenDelay'
  | 'allyDamage'
  | 'allyFireRate'
  | 'allyRange'
  | 'allyDamageTaken'
  | 'allyRegenRate'
  | 'allyRegenDelay'
  | 'exp';

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
 * Опыт вынесен в третью вкладку, а не приписан к одной из двух: он относится к
 * забегу целиком и не является характеристикой стрелка. Приписать его герою
 * значило бы, что «вкладка героя» — это на самом деле «герой и ещё экономика».
 *
 * Порядок вкладок и строк внутри них берётся отсюда: экран собирает разметку по
 * этому списку, руками там ничего не размечено.
 */
export const UPGRADE_TRACKS: readonly UpgradeTrack[] = [
  {
    id: 'hero',
    title: 'Герой',
    ids: ['heroDamage', 'heroFireRate', 'heroRange', 'heroDamageTaken', 'heroRegenRate', 'heroRegenDelay'],
  },
  {
    id: 'ally',
    title: 'Стрелки',
    ids: ['allyDamage', 'allyFireRate', 'allyRange', 'allyDamageTaken', 'allyRegenRate', 'allyRegenDelay'],
  },
  {
    id: 'common',
    title: 'Общее',
    ids: ['exp'],
  },
];

/** Плоский список всех улучшений — для сохранения, сброса и отладки. */
export const UPGRADE_IDS: readonly UpgradeId[] = UPGRADE_TRACKS.flatMap((track) => track.ids);

/**
 * Человеческие названия и описание эффекта — для экрана прокачки.
 *
 * Заголовки одинаковые у обеих веток намеренно: кого качаем, сказано вкладкой,
 * и дублировать это в каждой строке значит гонять по экрану лишние слова. А вот
 * описание эффекта разное — по нему видно, что множители правда разные.
 */
export const UPGRADE_LABELS: Record<UpgradeId, { title: string; effect: string }> = {
  heroDamage: { title: 'Урон', effect: 'урон снаряда героя' },
  heroFireRate: { title: 'Скорострельность', effect: 'выстрелов в секунду у героя' },
  heroRange: { title: 'Дальность стрельбы', effect: 'дальность полёта у героя' },
  heroDamageTaken: { title: 'Получаемый урон', effect: 'урон по герою' },
  heroRegenRate: { title: 'Восстановление HP', effect: 'скорость лечения героя' },
  heroRegenDelay: { title: 'Задержка лечения', effect: 'пауза после урона у героя' },

  allyDamage: { title: 'Урон', effect: 'урон снаряда стрелка' },
  allyFireRate: { title: 'Скорострельность', effect: 'выстрелов в секунду у стрелка' },
  allyRange: { title: 'Дальность стрельбы', effect: 'дальность полёта у стрелка' },
  allyDamageTaken: { title: 'Получаемый урон', effect: 'урон по доп. стрелкам' },
  allyRegenRate: { title: 'Восстановление HP', effect: 'скорость лечения стрелков' },
  allyRegenDelay: { title: 'Задержка лечения', effect: 'пауза после урона у стрелков' },

  exp: { title: 'Получаемый опыт', effect: 'опыт за забег' },
};

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
 * дальности, получаемого урона и опыта. Генерация мира (бочки, ворота, состав
 * зомби, скорость мира) не меняется ни на одном уровне прокачки.
 *
 * applyTo() записывает множители ЦЕЛИКОМ, абсолютным значением. Поэтому вызывать
 * его можно сколько угодно раз — накопления не будет, и снимок исходного конфига
 * не нужен.
 */
export class MetaProgress {
  private readonly levels = new Map<UpgradeId, number>();
  private bankValue = 0;

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

  /**
   * Знаменатель прогрессии цены у конкретного улучшения: своё поле, если задано,
   * иначе общий CONFIG.meta.costGrowth.
   *
   * Своё нужно веткам с другим числом уровней: цена последнего уровня — это
   * baseCost × costGrowth^(maxLevel−1), и при 15 уровнях вместо 50 общий
   * знаменатель дал бы совсем другой потолок цены.
   */
  private costGrowth(id: UpgradeId): number {
    // Тип выписан целиком, а не одним costGrowth?: TypeScript отвергает
    // присваивание объекта типу, у которого ВСЕ поля необязательные и ни одно не
    // совпадает («weak type»), — а поля costGrowth у боевых улучшений нет.
    const spec: { maxLevel: number; baseCost: number; stepPercent: number; costGrowth?: number } =
      CONFIG.meta.upgrades[id];
    return spec.costGrowth ?? CONFIG.meta.costGrowth;
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

  /** Итоговый множитель улучшения — то, что попадёт в конфиг. */
  multiplier(id: UpgradeId): number {
    const { stepPercent } = CONFIG.meta.upgrades[id];
    const step = (stepPercent / 100) * this.level(id);
    // Получаемый урон единственное, что уменьшается.
    return isReducingUpgrade(id) ? 1 - step : 1 + step;
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
    config.player.heroMultipliers.regenRateMultiplier = this.multiplier('heroRegenRate');
    config.player.heroMultipliers.regenDelayMultiplier = this.multiplier('heroRegenDelay');

    config.player.allyMultipliers.damageMultiplier = this.multiplier('allyDamage');
    config.player.allyMultipliers.fireRateMultiplier = this.multiplier('allyFireRate');
    config.player.allyMultipliers.rangeMultiplier = this.multiplier('allyRange');
    config.player.allyMultipliers.damageTakenMultiplier = this.multiplier('allyDamageTaken');
    config.player.allyMultipliers.regenRateMultiplier = this.multiplier('allyRegenRate');
    config.player.allyMultipliers.regenDelayMultiplier = this.multiplier('allyRegenDelay');

    config.player.expMultiplier = this.multiplier('exp');
  }

  /** Сбрасывает прогресс целиком (кнопка на экране прокачки). */
  reset(): void {
    this.levels.clear();
    this.bankValue = 0;
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

      if (typeof saved.levels === 'object' && saved.levels !== null) {
        for (const id of UPGRADE_IDS) {
          const value = saved.levels[id];
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          this.levels.set(id, this.clampLevel(id, value));
        }

        this.migrateLegacy(saved.levels as Record<string, unknown>);
      }
    } catch {
      // Невалидный JSON — просто стартуем с нуля.
      this.levels.clear();
      this.bankValue = 0;
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
    const payload: SavedProgress = { levels: {}, bank: this.bankValue };
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

    return { bank: +this.bankValue.toFixed(2), levels, multipliers, nextCosts };
  }
}
