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
  /**
   * Взрыв в точке попадания — круг того же вида, что у мины. Поля нет —
   * снаряд обычный, урон достаётся только той цели, в которую он попал.
   */
  blast?: { radius: number; damage: number };
}

/**
 * Типизированный доступ к таблице оружия. Читает конфиг каждый раз, а не
 * кэширует: числа можно крутить на живой игре.
 */
export function getWeapon(id: WeaponId): WeaponStats {
  return CONFIG.weapons[id];
}

/**
 * Кто держит ствол. Главный герой и доп. стрелок качаются РАЗНЫМИ ветками
 * мета-прокачки, поэтому одна и та же таблица оружия даёт им разные числа.
 */
export type ShooterKind = 'hero' | 'ally';

/*
 * Ниже — характеристики С УЧЁТОМ мета-прокачки (ТЗ раздел 11).
 *
 * Множители применяются здесь, в единственной точке чтения, а не мутацией
 * таблицы оружия: тогда база остаётся неприкосновенной и повторное применение
 * прогресса ничего не накапливает.
 *
 * Возвращаются числа, а не собранный объект: эти функции вызываются в горячем
 * цикле стрельбы на каждый выстрел каждого бойца, и объект там был бы мусором.
 *
 * kind обязателен во всех трёх аксессорах, значения по умолчанию нет намеренно:
 * умолчание «герой» тихо давало бы союзникам чужие числа в любом месте, где о
 * разделении забыли, — а забыть тут нечего, вызовов ровно четыре.
 */

/** Множители того набора, который относится к этому типу стрелка. */
function multipliersOf(kind: ShooterKind): typeof CONFIG.player.heroMultipliers {
  return kind === 'hero' ? CONFIG.player.heroMultipliers : CONFIG.player.allyMultipliers;
}

/** Урон снаряда с учётом прокачки. */
export function weaponDamage(id: WeaponId, kind: ShooterKind): number {
  return CONFIG.weapons[id].damage * multipliersOf(kind).damageMultiplier;
}

/** Выстрелов в секунду с учётом прокачки. */
export function weaponFireRate(id: WeaponId, kind: ShooterKind): number {
  return CONFIG.weapons[id].fireRate * multipliersOf(kind).fireRateMultiplier;
}

/**
 * Дальность с учётом прокачки.
 *
 * Огнемёт — особый случай: по ТЗ (раздел 6) его дальность ровно вдвое меньше
 * стрелковой, поэтому она ВЫВОДИТСЯ из стрелковой, а не масштабируется
 * самостоятельно. Иначе при росте прокачки соотношение из ТЗ разъехалось бы.
 */
export function weaponRange(id: WeaponId, kind: ShooterKind): number {
  const multiplier = multipliersOf(kind).rangeMultiplier;

  if (id === 'flamethrower') {
    return (CONFIG.weapons.pistol.range * multiplier) / 2;
  }

  return CONFIG.weapons[id].range * multiplier;
}

/**
 * Радиус взрыва снаряда, 0 — снаряд не взрывается.
 *
 * Прокачка радиус НЕ трогает: rangeMultiplier — про то, как далеко боец
 * достаёт, а не про то, сколько накрывает один снаряд. Растущая с прокачкой
 * зона поражения умножалась бы на растущий темп огня, и особое оружие ушло бы в
 * отрыв от всей таблицы.
 */
export function weaponBlastRadius(id: WeaponId): number {
  return getWeapon(id).blast?.radius ?? 0;
}

/**
 * Урон взрыва с учётом прокачки. 0 — снаряд не взрывается.
 *
 * Качается тем же damageMultiplier, что и урон снаряда: у гранатомёта взрыв —
 * часть выстрела, а не отдельный источник, и прокачка урона не должна тихо
 * переставать работать на половине его убойности.
 */
export function weaponBlastDamage(id: WeaponId, kind: ShooterKind): number {
  const blast = getWeapon(id).blast;
  return blast === undefined ? 0 : blast.damage * multipliersOf(kind).damageMultiplier;
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

/** Человеческие названия стволов — для магазина и отладочной строки. */
export const WEAPON_NAMES: Record<WeaponId, string> = {
  pistol: 'Пистолет',
  miniSmg: 'Пистолет-пулемёт',
  rifle: 'Автомат',
  machineGun: 'Пулемёт',
  flamethrower: 'Огнемёт',
  grenadeLauncher: 'Гранатомёт',
};

/** Позиция в магазине: что открывается и за сколько. */
export interface ShopWeapon {
  id: WeaponId;
  price: number;
}

/**
 * Список магазина (CONFIG.shop.weapons) с типом WeaponId вместо строки.
 *
 * Приведение здесь, в единственном месте: конфиг — обычный литерал, и вывести
 * из него WeaponId нельзя, а расползшиеся по коду `as WeaponId` перестали бы
 * ловить опечатку в ключе.
 */
export function shopWeapons(): readonly ShopWeapon[] {
  return CONFIG.shop.weapons as readonly ShopWeapon[];
}

/**
 * Обёртка нарисованной иконки. Высоту задаёт CSS, ширину — viewBox: чем длиннее
 * ствол, тем шире иконка, и разница в длине видна ещё до того, как разглядишь
 * силуэт. Цвет наследуется от подписи (`currentColor`), поэтому иконка тускнеет
 * вместе с ней, если у варианта задан свой цвет.
 */
function svgIcon(width: number, body: string): string {
  return (
    `<svg viewBox="0 0 ${width} 16" fill="currentColor"` +
    ` xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
}

/**
 * Иконки оружия — по ним видно, что лежит в бочке и что продаётся в магазине.
 *
 * Стрелковые ступени нарисованы, а не набраны эмодзи: пистолетный эмодзи в
 * Unicode ровно один (и на Apple он вообще водяной), так что пистолет-пулемёт,
 * автомат и пулемёт им не различить. Силуэты разведены по трём признакам,
 * читаемым на 16 пикселях: длина ствола, форма магазина и сошки.
 *   пистолет     — короткий ствол, скошенная рукоять, без приклада;
 *   пистолет-пулемёт — короткий, магазин в рукояти, приклад сложен;
 *   автомат      — длиннее, изогнутый магазин и приклад;
 *   пулемёт      — самый длинный, рёбра на стволе, короб снизу и сошки.
 * Особое оружие остаётся эмодзи: огонь и взрыв они передают лучше рисунка.
 */
const WEAPON_ICONS: Partial<Record<WeaponId, string>> = {
  // Пистолет в бочках не выпадает (он стартовый), иконка нужна магазину: там он
  // стоит первой строкой цепочки, и пустое место вместо ствола читалось бы как
  // сбой, а не как «уже есть».
  pistol: svgIcon(
    16,
    '<rect x="1.6" y="5.4" width="10.4" height="3.4" rx=".7"/>' +
      '<rect x="11.6" y="6" width="3.2" height="1.6" rx=".5"/>' +
      '<rect x="4.2" y="4.1" width="3" height="1.4" rx=".5"/>' +
      '<path d="M3.1 8.7h4l-1.5 5.6H2.2z"/>',
  ),
  miniSmg: svgIcon(
    22,
    '<rect x="1.4" y="6.6" width="3.2" height="1.4" rx=".5"/>' +
      '<rect x="4.2" y="4.9" width="10.6" height="4.2" rx=".8"/>' +
      '<rect x="6" y="3.4" width="3.6" height="1.5" rx=".5"/>' +
      '<rect x="14.4" y="6.3" width="6.6" height="1.9" rx=".6"/>' +
      '<rect x="17.4" y="4.5" width="1.3" height="1.8"/>' +
      '<path d="M6.9 9.1h4.2l-.8 5.9H6.2z"/>',
  ),
  rifle: svgIcon(
    30,
    '<path d="M1.6 6.3 8 5.5v4.1l-5.6.5z"/>' +
      '<rect x="7.6" y="4.9" width="11" height="4.3" rx=".8"/>' +
      '<rect x="17" y="7.7" width="6.2" height="2" rx=".7"/>' +
      '<rect x="18.6" y="5.9" width="10.4" height="1.8" rx=".6"/>' +
      '<rect x="25.8" y="3.8" width="1.5" height="2.2"/>' +
      '<path d="M9.8 9.2h3.2l-1 4.4H8.9z"/>' +
      '<path d="M14.4 9.2h4.4l-.4 3.3q-.3 2.2-2 2.2t-2.1-2.2z"/>',
  ),
  machineGun: svgIcon(
    34,
    '<path d="M1.4 5.3 7 4.8v4.9l-5.6.4z"/>' +
      '<rect x="6.6" y="4.3" width="13.4" height="5.3" rx=".9"/>' +
      '<rect x="7.9" y="9.5" width="6.6" height="4.5" rx=".7"/>' +
      '<path d="M16 9.7h3.3l-.9 3.5h-2.9z"/>' +
      '<rect x="19.4" y="5.5" width="13.2" height="2.6" rx=".7"/>' +
      '<rect x="22.6" y="3.5" width="1.4" height="2.1"/>' +
      '<rect x="25.6" y="3.5" width="1.4" height="2.1"/>' +
      '<rect x="28.6" y="3.5" width="1.4" height="2.1"/>' +
      '<path d="M25.2 8.1h1.6l3.2 6.7h-1.6L26 9.7l-2.4 5.1h-1.6z"/>',
  ),
  flamethrower: '🔥',
  grenadeLauncher: '💥',
};

/** Готовая разметка иконки ствола. null — для этого ключа рисунка нет. */
export function weaponIcon(id: WeaponId): string | null {
  return WEAPON_ICONS[id] ?? null;
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
   * kind — чьей веткой прокачки считается темп огня этого ствола. Хранится в
   * состоянии, а не передаётся в tick(): владелец ствола не меняется за всю
   * жизнь бойца, а tick зовётся каждый кадр у каждого.
   *
   * initialFraction — начальная заполненность накопителя, 0…1.
   * 1 (по умолчанию) — первый выстрел уходит сразу, иначе стрелок молчит первый
   * интервал. Случайное значение разносит фазы бойцов отряда: при одинаковом
   * оружии полностью синхронные накопители дают залпы вместо потока огня.
   */
  constructor(
    private currentWeapon: WeaponId,
    private readonly kind: ShooterKind,
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
    const fireRate = weaponFireRate(this.currentWeapon, this.kind);
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
