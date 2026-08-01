import { CONFIG } from '../config';

/** Стволы из таблицы раздела 6 ТЗ. */
export type WeaponId =
  | 'pistol'
  | 'miniSmg'
  | 'rifle'
  | 'machineGun'
  | 'flamethrower'
  | 'grenadeLauncher';

export interface WeaponStats {
  /** Выстрелов в секунду. */
  fireRate: number;
  /** Урон за снаряд, hp. */
  damage: number;
  /** Дальность полёта снаряда, units. */
  range: number;
}

/**
 * Типизированный доступ к таблице оружия. Читает конфиг каждый раз, а не
 * кэширует: числа можно крутить на живой игре.
 */
export function getWeapon(id: WeaponId): WeaponStats {
  return CONFIG.weapons[id];
}

/*
 * Ниже — характеристики С УЧЁТОМ мета-прокачки (ТЗ раздел 11).
 *
 * Множители применяются здесь, в единственной точке чтения, а не мутацией
 * таблицы оружия: тогда база остаётся неприкосновенной и повторное применение
 * прогресса ничего не накапливает.
 *
 * Возвращаются числа, а не собранный объект: эти функции вызываются в горячем
 * цикле стрельбы на каждый выстрел каждого бойца, и объект там был бы мусором.
 */

/** Урон снаряда с учётом прокачки. */
export function weaponDamage(id: WeaponId): number {
  return CONFIG.weapons[id].damage * CONFIG.player.damageMultiplier;
}

/** Выстрелов в секунду с учётом прокачки. */
export function weaponFireRate(id: WeaponId): number {
  return CONFIG.weapons[id].fireRate * CONFIG.player.fireRateMultiplier;
}

/**
 * Дальность с учётом прокачки.
 *
 * Огнемёт — особый случай: по ТЗ (раздел 6) его дальность ровно вдвое меньше
 * стрелковой, поэтому она ВЫВОДИТСЯ из стрелковой, а не масштабируется
 * самостоятельно. Иначе при росте прокачки соотношение из ТЗ разъехалось бы.
 */
export function weaponRange(id: WeaponId): number {
  const multiplier = CONFIG.player.rangeMultiplier;

  if (id === 'flamethrower') {
    return (CONFIG.weapons.pistol.range * multiplier) / 2;
  }

  return CONFIG.weapons[id].range * multiplier;
}

/**
 * Особое оружие (ТЗ раздел 6) — то, чего нет в цепочке прогрессии стрелкового.
 *
 * Признак выводится из ствола, а не хранится флагом на бойце: иначе флаг и
 * оружие могли бы разъехаться, и подбор стрелкового из бочки затёр бы особое.
 */
export function isSpecialWeapon(id: WeaponId): boolean {
  return !(CONFIG.weapons.progression as WeaponId[]).includes(id);
}

/** Случайное особое оружие из списка в конфиге. */
export function randomSpecialWeapon(): WeaponId {
  const list = CONFIG.weapons.special as WeaponId[];
  return list[Math.floor(Math.random() * list.length)] ?? 'flamethrower';
}

export interface BulletStyle {
  color: number;
  radiusScale: number;
  lengthScale: number;
  /**
   * Во сколько раз снаряд шире к КОНЦУ своей дальности. 1 (по умолчанию) —
   * летит неизменной толщины.
   */
  spread?: number;
  /**
   * Снаряд не гасится целью и наносит урон всем, кого пересёк. Заодно означает,
   * что попадания считаются по фактической ширине снаряда, а не по базовому
   * радиусу пули.
   */
  pierce?: boolean;
}

/** Вид снаряда для ствола: особое оружие выглядит иначе, чем стрелковое. */
export function bulletStyleFor(id: WeaponId): BulletStyle {
  const styles = CONFIG.weapons.bullet.styles as Record<string, BulletStyle | undefined>;
  return styles[id] ?? styles.default!;
}

/**
 * Ошибка конфига (fireRate 1e6) не должна вешать кадр бесконечным циклом.
 * Реальный максимум в таблице — огнемёт, 25/сек, то есть меньше одного выстрела
 * за шаг логики (с полной прокачкой темпа ×3 — около полутора); запас здесь
 * исключительно защитный.
 */
const MAX_SHOTS_PER_STEP = 16;

/**
 * Темп огня одного ствола (ТЗ раздел 6).
 *
 * Отдельный объект на каждого стрелка: в слое 5 у отряда будет много бойцов, а
 * в слое 7 у каждого может оказаться своё оружие — тогда достаточно выдать
 * бойцу свой WeaponState, не переписывая логику стрельбы.
 *
 * Накопитель, а не «один выстрел за кадр»: темп не зависит от частоты кадров и
 * не ломается, если fireRate станет больше 60.
 */
export class WeaponState {
  private accumulator: number;
  /** Интервал, с которым накопитель работал на прошлом шаге. */
  private lastInterval: number;

  /**
   * initialFraction — начальная заполненность накопителя, 0…1.
   * 1 (по умолчанию) — первый выстрел уходит сразу, иначе стрелок молчит первый
   * интервал. Случайное значение разносит фазы бойцов отряда: при одинаковом
   * оружии полностью синхронные накопители дают залпы вместо потока огня.
   */
  constructor(
    private currentWeapon: WeaponId,
    initialFraction = 1,
  ) {
    this.accumulator = this.interval * initialFraction;
    this.lastInterval = this.interval;
  }

  get weaponId(): WeaponId {
    return this.currentWeapon;
  }

  /**
   * Смена оружия (бочка с оружием в слоях 4 и 7). Первый выстрел из нового
   * ствола уходит сразу — подбор должен читаться мгновенно.
   */
  setWeapon(id: WeaponId): void {
    this.currentWeapon = id;
    this.accumulator = this.interval;
    this.lastInterval = this.interval;
  }

  private get interval(): number {
    // Через аксессор, а не напрямую из таблицы: темп должен учитывать прокачку.
    const fireRate = weaponFireRate(this.currentWeapon);
    return fireRate > 0 ? 1 / fireRate : Number.POSITIVE_INFINITY;
  }

  /** Сколько выстрелов сделать на этом шаге логики. */
  tick(dt: number): number {
    const interval = this.interval;
    if (!Number.isFinite(interval)) return 0;

    // Интервал сменился (другое оружие или правка fireRate в конфиге на живой
    // игре) — обрезаем накопленный долг. Иначе долг медленного ствола, до 0.5 с
    // у пистолета, разом выльется в очередь: при переходе на пулемёт это 7 пуль
    // в одном шаге логики.
    if (interval !== this.lastInterval) {
      this.accumulator = Math.min(this.accumulator, interval);
      this.lastInterval = interval;
    }

    this.accumulator += dt;

    let shots = 0;
    while (this.accumulator >= interval && shots < MAX_SHOTS_PER_STEP) {
      shots++;
      this.accumulator -= interval;
    }

    // Долг сверх лимита не копим: иначе после смены оружия на медленное
    // накопитель выстрелит очередью из накопленного.
    if (shots === MAX_SHOTS_PER_STEP) {
      this.accumulator = 0;
    }

    return shots;
  }
}
