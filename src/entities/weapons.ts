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

/**
 * Урон снаряда с учётом прокачки: множитель своей ветки × общий урон отряда
 * (player.squadDamageMultiplier — ветка squadDamage, одна на всех стрелков).
 */
export function weaponDamage(id: WeaponId, kind: ShooterKind): number {
  return (
    CONFIG.weapons[id].damage *
    multipliersOf(kind).damageMultiplier *
    CONFIG.player.squadDamageMultiplier
  );
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
  if (blast === undefined) return 0;
  // Общий урон отряда входит по той же причине, что damageMultiplier: взрыв —
  // часть выстрела, и множитель не должен тихо терять половину убойности гранаты.
  return blast.damage * multipliersOf(kind).damageMultiplier * CONFIG.player.squadDamageMultiplier;
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

/**
 * Сила особого оружия — позиция в CONFIG.weapons.special (чем дальше, тем
 * сильнее), у стрелкового −1. По этой шкале решается, кого выпавший ствол
 * способен усилить: гранатомёт заменяет и стрелковое, и огнемёт, огнемёт —
 * только стрелковое. Обратной замены (огнемёт поверх гранатомёта) нет —
 * это был бы даунгрейд, а не бонус.
 */
export function specialWeaponRank(id: WeaponId): number {
  return (CONFIG.weapons.special as WeaponId[]).indexOf(id);
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

/** Замок ступени оружия — номер волны и/или счёт убийств в волне, см. CONFIG.run.unlocks.weapons. */
interface WeaponUnlockGate {
  kills?: number;
  fromWave?: number;
}

/**
 * Замок ствола из конфига. Приведение здесь, по той же причине, что и у
 * shopWeapons() выше: одно место на всю игру.
 */
function unlockGate(id: WeaponId): WeaponUnlockGate {
  const gates = CONFIG.run.unlocks.weapons as Partial<Record<WeaponId, WeaponUnlockGate>>;
  return gates[id] ?? {};
}

/**
 * Какое по счёту убийство ТЕКУЩЕЙ волны открывает ствол. 0 — замка по
 * убийствам нет: ствол доступен с первого кадра волны. Счётчик волновый
 * (RunState.killedZombies), поэтому на каждой волне порог отрабатывает заново.
 */
export function weaponUnlockKills(id: WeaponId): number {
  return unlockGate(id).kills ?? 0;
}

/**
 * Волна, с которой ствол может выпасть, она же волна, до которой нужно дойти,
 * чтобы открыть ствол в магазине. 1 — замка по волне нет: первая волна есть в
 * любой вылазке.
 */
export function weaponUnlockWave(id: WeaponId): number {
  return unlockGate(id).fromWave ?? 1;
}

/**
 * Обёртка нарисованной иконки. Высоту задаёт CSS, ширину — viewBox: чем длиннее
 * ствол, тем шире иконка, и разница в длине видна ещё до того, как разглядишь
 * силуэт. Цвета фигур задают классы `wpn-*` из styles.css — все цвета
 * интерфейса живут там; `currentColor` на обёртке остался запасным на случай
 * фигуры без класса. className вешается на корень svg — по нему CSS отличает
 * фигурки стрелков от стволов (у них другая высота).
 */
function svgIcon(width: number, body: string, className = ''): string {
  const classAttr = className === '' ? '' : ` class="${className}"`;
  return (
    `<svg${classAttr} viewBox="0 0 ${width} 16" fill="currentColor"` +
    ` xmlns="http://www.w3.org/2000/svg">${body}</svg>`
  );
}

/**
 * Иконки оружия — по ним видно, что лежит в бочке и что продаётся в магазине.
 *
 * Все шесть нарисованы, а не набраны эмодзи: пистолетный эмодзи в Unicode
 * ровно один (и на Apple он вообще водяной), а огню и взрыву эмодзи-заменой
 * не передать, КАКОЙ именно ствол внутри. Прототипы заданы пользователем
 * (2026-08-04), силуэты сведены к признакам, читаемым на 16 пикселях:
 *   пистолет     — Colt M1911: прямой затвор, курок сзади, скошенная рукоять;
 *   пистолет-пулемёт — MAC-10: короткая коробка, магазин сквозь рукоять
 *                  посередине, огрызок ствола с резьбой;
 *   автомат      — АК-74: деревянные приклад и цевьё, рожок вперёд, длинный
 *                  дульный тормоз;
 *   пулемёт      — минипулемёт M134: блок из трёх видимых стволов с обоймами,
 *                  толстый корпус мотора, ручка сверху;
 *   огнемёт      — огнемёт Пиро из TF2: красная труба, баллон снизу, две
 *                  рукояти, пилотный огонёк у сопла;
 *   гранатомёт   — РПГ-7: раструб сзади, деревянная накладка, две рукояти,
 *                  конус гранаты шире трубы.
 * Раскраска — классами по ролям (сталь/металл/тёмное/дерево/олива/красный/
 * пламя), сама палитра в styles.css рядом с размерами иконок.
 */
const WEAPON_ICONS: Partial<Record<WeaponId, string>> = {
  // Пистолет в бочках не выпадает (он стартовый), иконка нужна магазину: там он
  // стоит первой строкой цепочки, и пустое место вместо ствола читалось бы как
  // сбой, а не как «уже есть».
  pistol: svgIcon(
    17,
    '<rect class="wpn-dark" x="0.6" y="3.9" width="1.4" height="1.8" rx=".3"/>' +
      '<rect class="wpn-steel" x="1.4" y="4.4" width="12.8" height="3.2" rx=".6"/>' +
      '<rect class="wpn-dark" x="12.9" y="3.5" width="1" height="1.1"/>' +
      '<rect class="wpn-metal" x="14" y="5" width="1.6" height="1.7" rx=".3"/>' +
      '<rect class="wpn-metal" x="2.4" y="7.4" width="10.6" height="1.3"/>' +
      '<path class="wpn-wood" d="M3.4 8.5h3.8l-1.3 5.5q-.15.7-.85.7H3.5q-.7 0-.6-.7z"/>' +
      '<path class="wpn-metal" d="M7.4 8.7h2.2q-.1 1.7-1.9 2z"/>',
  ),
  miniSmg: svgIcon(
    20,
    '<rect class="wpn-metal" x="0.4" y="4.8" width="1.4" height="3.4" rx=".3"/>' +
      '<rect class="wpn-metal" x="8.2" y="9" width="2" height="6.6" rx=".3"/>' +
      '<rect class="wpn-dark" x="1.8" y="4.1" width="13.4" height="4.9" rx=".5"/>' +
      '<rect class="wpn-metal" x="7" y="3" width="2.4" height="1.2" rx=".3"/>' +
      '<rect class="wpn-metal" x="15.2" y="5.7" width="2.2" height="1.7"/>' +
      '<rect class="wpn-steel" x="17.4" y="5.4" width="1.6" height="2.3" rx=".4"/>' +
      '<path class="wpn-dark" d="M7.2 9h4l-.5 3.6H7.7z"/>',
  ),
  rifle: svgIcon(
    30,
    '<path class="wpn-wood" d="M.6 5.6 6.6 5v4.8L1.5 9.3q-.9 0-.9-.9z"/>' +
      '<rect class="wpn-metal" x="6.2" y="4.6" width="9.2" height="4.3" rx=".4"/>' +
      '<rect class="wpn-dark" x="7.6" y="3.5" width="2.6" height="1.3" rx=".3"/>' +
      '<rect class="wpn-metal" x="15.4" y="4.3" width="6.8" height="1.4"/>' +
      '<rect class="wpn-wood" x="15.4" y="6.1" width="5.4" height="2.3" rx=".4"/>' +
      '<rect class="wpn-steel" x="20.8" y="5.8" width="5.4" height="1.3"/>' +
      '<rect class="wpn-dark" x="24.6" y="3.8" width="1.2" height="2"/>' +
      '<rect class="wpn-steel" x="26.4" y="5.1" width="3.2" height="2.6" rx=".6"/>' +
      '<rect class="wpn-dark" x="27.7" y="5.5" width=".8" height="1.8"/>' +
      '<path class="wpn-wood" d="M10.4 8.9h2.9l-1 3.4q-.15.5-.7.5h-1.6q-.6 0-.5-.6z"/>' +
      '<path class="wpn-dark" d="M13.7 8.9h4.1q.2 3.4 2.4 5.3l-2.4 1.1q-2.4-2.5-2.1-6.4z"/>',
  ),
  machineGun: svgIcon(
    34,
    '<rect class="wpn-dark" x="0.4" y="4.7" width="1.8" height="1.3" rx=".3"/>' +
      '<rect class="wpn-dark" x="0.4" y="9.1" width="1.8" height="1.3" rx=".3"/>' +
      '<rect class="wpn-dark" x="2.2" y="3.9" width="9" height="7.4" rx="1.3"/>' +
      '<rect class="wpn-metal" x="4" y="2.4" width="5.4" height="1.2" rx=".5"/>' +
      '<rect class="wpn-metal" x="11.2" y="4.3" width="1.6" height="6.6" rx=".3"/>' +
      '<rect class="wpn-metal" x="12.8" y="4.6" width="17" height="1.15"/>' +
      '<rect class="wpn-steel" x="12.8" y="7.1" width="17.6" height="1.15"/>' +
      '<rect class="wpn-metal" x="12.8" y="9.6" width="17" height="1.15"/>' +
      '<rect class="wpn-dark" x="20" y="4" width="1.7" height="7.2" rx=".4"/>' +
      '<rect class="wpn-dark" x="27.6" y="4" width="1.7" height="7.2" rx=".4"/>',
  ),
  flamethrower: svgIcon(
    31,
    '<path class="wpn-dark" d="M1.9 8.1h3l-.7 3.4H2.4z"/>' +
      '<rect class="wpn-metal" x="0.6" y="4.5" width="3" height="3.4" rx=".6"/>' +
      '<rect class="wpn-red" x="3.6" y="4.8" width="19.6" height="2.8" rx="1"/>' +
      '<rect class="wpn-metal" x="8.8" y="8.4" width="9" height="3.4" rx="1.7"/>' +
      '<rect class="wpn-dark" x="19.6" y="7.6" width="1.7" height="3.4" rx=".5"/>' +
      '<rect class="wpn-metal" x="23.2" y="4.3" width="1.8" height="3.8" rx=".4"/>' +
      '<rect class="wpn-steel" x="25" y="5.4" width="2.6" height="1.6"/>' +
      '<path class="wpn-flame" d="M27.6 7.8q-1-.7-1-1.7 0-1.4 1.6-2.4-.3 1 .4 1.7.7.6.7 1.3 0 1.1-1.7 1.1z"/>',
  ),
  grenadeLauncher: svgIcon(
    34,
    '<path class="wpn-dark" d="M.4 4.3l3.4 1.5v2.8L.4 10.1Q0 10 0 9.6V4.8q0-.4.4-.5z"/>' +
      '<rect class="wpn-olive" x="3.4" y="5.6" width="17.4" height="2.7"/>' +
      '<rect class="wpn-wood" x="5.4" y="5" width="6.2" height="3.9" rx=".9"/>' +
      '<rect class="wpn-dark" x="12.6" y="3.7" width="1.5" height="1.5" rx=".3"/>' +
      '<path class="wpn-dark" d="M12.8 8.7h2.7l-.8 3.5h-2.3z"/>' +
      '<path class="wpn-dark" d="M16.6 8.7h2.7l-.8 3.5h-2.3z"/>' +
      '<rect class="wpn-metal" x="20.4" y="4.8" width="1.4" height="4.3" rx=".3"/>' +
      '<path class="wpn-olive" d="M21.8 4.6q2.4-.9 3.6-.5l7.3 2.3q.6.2.6.7t-.6.7l-7.3 2.3q-1.2.4-3.6-.5z"/>',
  ),
};

/** Готовая разметка иконки ствола. null — для этого ключа рисунка нет. */
export function weaponIcon(id: WeaponId): string | null {
  return WEAPON_ICONS[id] ?? null;
}

/*
 * ФИГУРКА СТРЕЛКА (задано пользователем, 2026-08-04) — вид сбоку, поза
 * стрельбы из автомата, лицом вправо, как смотрят стволы в WEAPON_ICONS.
 * Одета по требованию: куртка защитного цвета, серые штаны, чёрные ботинки
 * и волосы; автомат нарисован в руках. Порядок фигур смысловой: кисти
 * ложатся ПОВЕРХ автомата (иначе он лежал бы на руках), лицо поверх волос —
 * так затылок и макушка остаются тёмным полумесяцем.
 *
 * Габарит одной фигурки — 14 × 16 (x 3.5…13.7), той же высоты, что иконки
 * стволов: в подписи над бочкой они стоят рядом и обязаны совпадать ростом.
 */
const SHOOTER_FIGURE =
  '<circle class="fig-black" cx="7.1" cy="2.9" r="1.75"/>' +
  '<circle class="fig-skin" cx="7.7" cy="3.4" r="1.3"/>' +
  '<path class="wpn-olive" d="M5.4 4.8h3.1l.4 5H5.2z"/>' +
  '<rect class="wpn-olive" x="7.2" y="5" width="3.6" height="1.4" rx=".6"/>' +
  '<rect class="wpn-dark" x="6.8" y="5.4" width="6.9" height="1.1" rx=".3"/>' +
  '<path class="wpn-dark" d="M10.2 6.5h1.7l-.5 1.9h-1.6z"/>' +
  '<rect class="fig-skin" x="10.5" y="5.3" width="1.2" height="1.2" rx=".4"/>' +
  '<rect class="fig-skin" x="12" y="5.3" width="1.1" height="1.2" rx=".4"/>' +
  '<path class="fig-pants" d="M5.5 9.6 4 13.9h1.6l1.9-4z"/>' +
  '<path class="fig-pants" d="M7.3 9.7l1.2 2 .3 2.2h1.6l-.6-3-.9-1.4z"/>' +
  '<rect class="fig-black" x="3.5" y="13.7" width="2.4" height="1.7" rx=".4"/>' +
  '<rect class="fig-black" x="8.6" y="13.7" width="2.5" height="1.7" rx=".4"/>';

/** Шаг между фигурками в строю: чуть меньше ширины фигуры — ряды перекрываются. */
const SHOOTER_STEP = 6.6;

/**
 * Иконка стрелков: count фигурок шахматным строем, как встаёт отряд.
 * Нечётные позиции приподняты и рисуются ПЕРВЫМИ — они дальний ряд, и
 * ближний перекрывает их, как в настоящей колонне. Ширина растёт с числом
 * бойцов, поэтому у иконки свой viewBox, как у длинных стволов.
 *
 * Класс icon-shooters делает фигурки в 1.5 раза выше стволов (задано
 * пользователем, 2026-08-04) — высоты лежат в styles.css рядом с палитрой.
 */
export function shootersIcon(count: number): string {
  const n = Math.max(1, Math.round(count));
  const width = 14 + (n - 1) * SHOOTER_STEP;

  const order = [...Array(n).keys()].sort((a, b) => (b % 2) - (a % 2));
  const body = order
    .map((i) => {
      const dx = +(i * SHOOTER_STEP).toFixed(1);
      const dy = i % 2 === 1 ? -1.3 : 0;
      return `<g transform="translate(${dx} ${dy})">${SHOOTER_FIGURE}</g>`;
    })
    .join('');

  return svgIcon(width, body, 'icon-shooters');
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
  /**
   * Множитель к общей скорости снаряда (bullet.speed). 1 (по умолчанию) — летит
   * с базовой скоростью. Дальность при этом не меняется: она отсчитывается по
   * пройденному пути, поэтому медленный снаряд просто дольше живёт.
   */
  speedScale?: number;
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
