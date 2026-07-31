import { CONFIG } from '../config';

/** Ключи улучшений. Совпадают с ключами CONFIG.meta.upgrades. */
export type UpgradeId = 'damage' | 'fireRate' | 'range' | 'damageTaken' | 'exp';

export const UPGRADE_IDS: readonly UpgradeId[] = [
  'damage',
  'fireRate',
  'range',
  'damageTaken',
  'exp',
];

/** Человеческие названия и описание эффекта — для экрана прокачки. */
export const UPGRADE_LABELS: Record<UpgradeId, { title: string; effect: string }> = {
  damage: { title: 'Урон', effect: 'урон снаряда' },
  fireRate: { title: 'Скорострельность', effect: 'выстрелов в секунду' },
  range: { title: 'Дальность стрельбы', effect: 'дальность полёта' },
  damageTaken: { title: 'Получаемый урон', effect: 'урон по отряду' },
  exp: { title: 'Получаемый опыт', effect: 'опыт за забег' },
};

interface SavedProgress {
  levels: Partial<Record<UpgradeId, number>>;
  bank: number;
}

/**
 * Мета-прогрессия между забегами (ТЗ раздел 11).
 *
 * Держит уровни пяти улучшений и банк EXP, считает цены, продаёт уровни,
 * сохраняется в localStorage и применяет результат к CONFIG.
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
   * Цена СЛЕДУЮЩЕГО уровня: baseCost × costGrowth^level.
   * Экспонента даёт дешёвое начало и дорогой хвост: первые уровни берутся
   * десятками за забег, последние стоят десятки забегов.
   * null — уровень уже максимальный.
   */
  nextCost(id: UpgradeId): number | null {
    if (this.isMaxed(id)) return null;
    const { baseCost } = CONFIG.meta.upgrades[id];
    return Math.round(baseCost * CONFIG.meta.costGrowth ** this.level(id));
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

    while (count < limit && level < maxLevel) {
      const cost = Math.round(baseCost * CONFIG.meta.costGrowth ** level);
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
    return id === 'damageTaken' ? 1 - step : 1 + step;
  }

  /**
   * Переносит прогресс в конфиг. Значения записываются целиком, поэтому вызов
   * идемпотентен: применить дважды — то же, что применить один раз.
   */
  applyTo(config: typeof CONFIG = CONFIG): void {
    config.player.damageMultiplier = this.multiplier('damage');
    config.player.fireRateMultiplier = this.multiplier('fireRate');
    config.player.rangeMultiplier = this.multiplier('range');
    config.player.damageTakenMultiplier = this.multiplier('damageTaken');
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
          // Зажимаем в допустимый диапазон: сохранение могло быть от версии
          // с другим maxLevel или отредактировано вручную.
          this.levels.set(id, Math.min(Math.max(Math.floor(value), 0), this.maxLevel(id)));
        }
      }
    } catch {
      // Невалидный JSON — просто стартуем с нуля.
      this.levels.clear();
      this.bankValue = 0;
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
