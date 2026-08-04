import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
  Vector2,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import { segmentHitsCircle, segmentPassesCircle } from '../core/collision';
import type { RunState } from '../core/run';
import type { BonusSlot } from './bonusSlot';
import type { CrystalPool } from './crystals';
import type { SquadTarget } from './enemies';
import { makeFlashColor } from './flash';
import {
  randomSpecialWeapon,
  shootersIcon,
  weaponIcon,
  weaponUnlockKills,
  weaponUnlockWave,
  type WeaponId,
} from './weapons';

/** Что лежит в бочке (ТЗ раздел 7). */
export type BarrelContent = 'weapon' | 'shooters' | 'special' | 'mine';

/**
 * Магазин со стороны бочек: разрешено ли этому стволу вообще появляться.
 *
 * Узкий интерфейс у потребителя, как SquadTarget и BonusReceiver: бочки не
 * должны знать ни про деньги, ни про MetaProgress — только про запрет.
 *
 * Купленное оружие — ВТОРОЙ замок поверх замка внутри забега
 * (CONFIG.run.unlocks.weapons), а не замена ему: ствол должен быть и куплен
 * между вылазками, и дожить до своей волны и своего счёта убийств внутри неё.
 */
export interface WeaponUnlocks {
  /** true — этот ствол куплен и может выпадать. Пистолет открыт всегда. */
  isWeaponUnlocked(id: WeaponId): boolean;

  /**
   * Отметка «особое подобрано из бочки» — открывает его аренду в бустерах.
   * Зовётся при фактической выдаче ствола бойцу, см. applyContent.
   */
  markSpecialPicked(id: WeaponId): void;
}

/** Отряд, который может получить содержимое бочки. */
export interface BonusReceiver {
  /**
   * Повышает стрелковое оружие всего отряда на ступень (ТЗ раздел 6).
   * Возвращает новое оружие или null, если ступень уже последняя.
   */
  upgradeSquadWeapon(): WeaponId | null;

  /** Добавляет доп. стрелков в строй (ТЗ раздел 5). */
  addShooters(count: number): void;

  /** Текущее общее стрелковое оружие отряда — по нему считается следующая ступень. */
  readonly weaponId: WeaponId;

  /** Выдаёт особое оружие одному бойцу: сначала герою, потом случайному (ТЗ раздел 6). */
  giveSpecialWeapon(id: WeaponId): 'hero' | 'ally' | null;

  /**
   * Способен ли особый ствол усилить хоть кого-то. По нему бочки не предлагают
   * бесполезное особое: огнемёт не выпадает отряду, где у всех гранатомёты.
   */
  specialWeaponBenefits(id: WeaponId): boolean;

  /** Расставляет противопехотные мины перед отрядом (ТЗ раздел 7). */
  deployMines(count?: number): void;

  /** Наезд бочки: урон всем стрелкам в полосе шириной хитбокса. */
  damageShootersInBand(centerX: number, halfWidth: number, damage: number): number;
}

/**
 * Иконка содержимого над бочкой (ТЗ раздел 7).
 *
 * weaponTier — ступень стрелкового, которую бочка выдаст. Она считается на
 * месте вызова, а не хранится с момента спавна: бочка отдаёт ступень СЛЕДУЮЩУЮ
 * за текущей на момент вскрытия, и посчитанная иконка совпадает с ней по
 * построению. Запомненная — разошлась бы, подними отряд оружие иначе.
 *
 * Для стрелков ТЗ задаёт особое правило: до 4 — просто N фигурок (нарисованных,
 * шахматным строем — см. shootersIcon), свыше — 4 фигурки и множитель «×N»
 * поверх, иначе десяток фигурок не читается. Строка «svg + ×N» работает,
 * потому что labels.ts вставляет иконки через innerHTML: хвост после svg
 * становится обычным текстом рядом с рисунком.
 */
function contentIcon(
  content: BarrelContent,
  amount: number,
  special: WeaponId | null,
  weaponTier: WeaponId | null,
): string {
  if (content === 'weapon') {
    return (weaponTier !== null ? weaponIcon(weaponTier) : null) ?? '🔫';
  }
  if (content === 'mine') return '💣';
  if (content === 'special') return (special !== null ? weaponIcon(special) : null) ?? '✨';

  const { iconFigureLimit } = CONFIG.barrels.content;
  if (amount <= iconFigureLimit) return shootersIcon(amount);

  return `${shootersIcon(iconFigureLimit)}×${amount}`;
}

/** Состояние прочности бочки — от него зависит цвет тела. */
type BarrelVariant = 'intact' | 'cracked50' | 'cracked25';

/**
 * Полудлина бочки вдоль её собственной оси и радиус в самом широком месте.
 * Геометрия строится в СВОИХ координатах, где ось тела вращения направлена по y;
 * куда эта ось смотрит в мире, решает стиль (см. barrelSpanX).
 */
const halfLength = (): number => CONFIG.barrels.length / 2;
const maxRadius = (): number => CONFIG.barrels.diameter / 2;

/** Лежит ли бочка на боку — тогда она ещё и катится. */
const isRolling = (): boolean => CONFIG.barrels.style === 'rolling';

/**
 * Габарит бочки по мировым осям. Стоящая обращена к дороге диаметром, лежащая —
 * длиной; глубина (Z) у обеих равна диаметру, потому что вдоль дороги в обоих
 * случаях смотрит одна и та же окружность.
 *
 * Считается функциями, а не одним объектом: barrelSpanX спрашивают на каждую
 * пулю, и аллокация вектора там недопустима.
 */
const barrelSpanX = (): number => (isRolling() ? CONFIG.barrels.length : CONFIG.barrels.diameter);
const barrelSpanY = (): number => (isRolling() ? CONFIG.barrels.diameter : CONFIG.barrels.length);
const barrelSpanZ = (): number => CONFIG.barrels.diameter;

/**
 * Радиус тела бочки в точке t, где t — доля полудлины в [-1, 1].
 *
 * Косинус, а не парабола: у косинуса производная в середине нулевая, поэтому в
 * самом широком месте бок плавный, а к донышкам сходится быстрее — ровно тот
 * силуэт, по которому бочка узнаётся с одного взгляда.
 */
function barrelRadiusAt(t: number): number {
  const { endRadiusRatio } = CONFIG.barrels.shape;
  return maxRadius() * (endRadiusRatio + (1 - endRadiusRatio) * Math.cos((t * Math.PI) / 2));
}

/**
 * Тело бочки — фигура вращения по профилю barrelRadiusAt.
 *
 * Крайние точки лежат НА ОСИ (x = 0): из них LatheGeometry собирает донышки.
 * Без них бочка была бы трубой, и сквозь торец было бы видно дорогу.
 */
function buildBarrelBody(): LatheGeometry {
  const { radialSegments, heightSegments } = CONFIG.barrels.shape;
  const half = halfLength();

  const points = [new Vector2(0, -half)];
  for (let s = 0; s <= heightSegments; s++) {
    const t = -1 + (2 * s) / heightSegments;
    points.push(new Vector2(barrelRadiusAt(t), t * half));
  }
  points.push(new Vector2(0, half));

  return new LatheGeometry(points, radialSegments);
}

/**
 * Обруч в точке offsetRatio (доля полудлины, знак — к одному или другому торцу).
 *
 * Открытый цилиндр: изнутри обруч не виден никогда, а торцы съедаются телом.
 * Радиусы с двух сторон берутся с профиля тела, поэтому обруч ложится по боку,
 * а не висит цилиндром на пузатой бочке.
 */
function buildHoopGeometry(offsetRatio: number): CylinderGeometry {
  const { radialSegments, hoopHeight, hoopOverhang } = CONFIG.barrels.shape;
  const half = hoopHeight / 2 / halfLength();

  return new CylinderGeometry(
    barrelRadiusAt(offsetRatio + half) + hoopOverhang,
    barrelRadiusAt(offsetRatio - half) + hoopOverhang,
    hoopHeight,
    radialSegments,
    1,
    true,
  );
}

/**
 * Обод по кромке донышка — тор в плоскости самого донышка.
 *
 * Радиус кольца равен радиусу кромки, поэтому тор садится НА неё: половина
 * ширины снаружи силуэта, половина поверх донышка. Так видно тёмное кольцо и
 * цветную середину — и «бочка», и состояние прочности одновременно.
 */
function buildEndRimGeometry(): TorusGeometry {
  const { radialSegments, endRimTube } = CONFIG.barrels.shape;
  // 6 сегментов на сечение: тор тонкий, гранёности сечения на экране не видно.
  return new TorusGeometry(barrelRadiusAt(1), endRimTube / 2, 6, radialSegments);
}

/**
 * Продольный шов между клёпками — узкая полоска по боку бочки от торца до торца.
 *
 * Ровно то, по чему видно вращение: тело и обручи вокруг оси симметричны, и без
 * швов катящаяся бочка на экране неотличима от скользящей. Строится тем же
 * профилем, что и тело, но приподнятым на staveLift и обрезанным по углу
 * (phiStart/phiLength у LatheGeometry), поэтому шов повторяет пузо и не тонет
 * в нём у донышек, как утонула бы прямая планка.
 */
function buildStaveGeometry(index: number): LatheGeometry {
  const { heightSegments, staveCount, staveWidth, staveLift } = CONFIG.barrels.shape;
  const half = halfLength();
  const phiLength = staveWidth / maxRadius();
  const phiStart = (index * 2 * Math.PI) / staveCount - phiLength / 2;

  const points: Vector2[] = [];
  for (let s = 0; s <= heightSegments; s++) {
    const t = -1 + (2 * s) / heightSegments;
    points.push(new Vector2(barrelRadiusAt(t) + staveLift, t * half));
  }

  // 2 сегмента по дуге: полоска узкая, кривизны внутри неё не видно.
  return new LatheGeometry(points, 2, phiStart, phiLength);
}

/**
 * Бочки-бонусы (ТЗ раздел 7).
 *
 * Едут сверху вниз вместе с миром. Модель у бочки одна, а стоять на дороге она
 * умеет двумя способами (CONFIG.barrels.style): 'standing' — на донышке, как
 * поставленная бочка; 'rolling' — на боку поперёк дороги, и тогда она ещё и
 * катится на отряд (угол качения привязан к пройденному пути, поэтому бочка не
 * «скользит» на месте). Стиль решает и положение меша, и габарит хитбокса.
 *
 * Над бочкой — число прочности; попадания его
 * уменьшают, на 50% и 25% меняется вид, при нуле бочка ломается и отдаёт
 * содержимое отряду. От целой бочки можно увернуться: тогда ни бонуса, ни урона.
 * Контакт целой бочки с отрядом бьёт стрелков.
 *
 * Пул — отдельные Mesh, а не InstancedMesh: бочек единицы, зато каждой нужен
 * свой цвет под состояние трещин. Меши создаются один раз, дальше только
 * прячутся и показываются.
 */
export class BarrelField {
  private readonly meshes: Mesh[] = [];
  private readonly materials: MeshStandardMaterial[] = [];

  /**
   * Цвет тела по состоянию трещин и вспышка к каждому из них.
   *
   * Считаются ОДИН раз на поле, а не на кадр: цвет ставится каждой видимой
   * бочке каждый кадр, и аллокация Color там недопустима. Вспышка своя на каждое
   * состояние, потому что она — светлый оттенок СОБСТВЕННОГО цвета цели
   * (см. entities/flash.ts), а собственный цвет у треснувшей бочки другой.
   */
  private readonly bodyColors: Record<BarrelVariant, Color>;
  private readonly flashColors: Record<BarrelVariant, Color>;

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  private readonly hp: Float32Array;
  private readonly maxHp: Float32Array;
  /** Остаток вспышки от полученного урона, секунды. */
  private readonly flashLeft: Float32Array;
  private readonly content: BarrelContent[] = [];
  /** Сколько выдаёт содержимое: для «стрелков» — число бойцов. */
  private readonly amount: Float32Array;
  /** Какое именно особое оружие лежит внутри (только для content = 'special'). */
  private readonly special: Array<WeaponId | null> = [];

  private count = 0;
  private spawnTimer = 0;

  /**
   * Во время боссфайта бонусы не появляются (ТЗ раздел 10) — но уже выехавшие
   * продолжают ехать, поэтому гасится именно спавн, а не обновление.
   */
  spawnEnabled = true;

  private brokenTotal = 0;
  private dodgedTotal = 0;
  private crushedTotal = 0;

  /**
   * squad получаем сразу и держим: попадания приходят из BulletPool, чей тип
   * проверки фиксирован (x, zFrom, zTo, damage) и лишний аргумент не пропустит.
   */
  constructor(
    scene: Scene,
    private readonly squad: SquadTarget & BonusReceiver,
    private readonly crystals: CrystalPool,
    private readonly run: RunState,
    private readonly bonusSlot: BonusSlot,
    private readonly shop: WeaponUnlocks,
  ) {
    const { poolSize, colors, shape } = CONFIG.barrels;

    this.bodyColors = {
      intact: new Color(colors.intact),
      cracked50: new Color(colors.cracked50),
      cracked25: new Color(colors.cracked25),
    };
    this.flashColors = {
      intact: makeFlashColor(colors.intact),
      cracked50: makeFlashColor(colors.cracked50),
      cracked25: makeFlashColor(colors.cracked25),
    };

    // Геометрия одна на все бочки, материал — свой на каждую (нужен свой цвет).
    // Обручи же одинаковые у всех и цвет не меняют — им хватает одного материала.
    const bodyGeometry = buildBarrelBody();
    const half = halfLength();
    // Накладки: два обруча, ободы по обеим кромкам и продольные швы. Тор задан
    // в плоскости XY, поэтому его кладут поперёк оси поворотом на четверть
    // оборота; швы уже построены вдоль оси и доворота не требуют.
    //
    // Модель СИММЕТРИЧНА и одинакова для обоих стилей — в том числе поэтому
    // ободов два, а не один по верхней кромке. Так стиль ни на что не влияет в
    // конструкторе, и его можно переключать на живой игре (__config.barrels.style),
    // как и остальные числа конфига. У стоящей бочки нижний обод виден тоже —
    // тёмное кольцо у самого асфальта, оно её только приземляет.
    const trims: Array<{ geometry: BufferGeometry; y: number; flat: boolean }> = [
      { geometry: buildHoopGeometry(-shape.hoopOffsetRatio), y: -shape.hoopOffsetRatio * half, flat: false },
      { geometry: buildHoopGeometry(shape.hoopOffsetRatio), y: shape.hoopOffsetRatio * half, flat: false },
      { geometry: buildEndRimGeometry(), y: -half, flat: true },
      { geometry: buildEndRimGeometry(), y: half, flat: true },
    ];
    for (let s = 0; s < shape.staveCount; s++) {
      trims.push({ geometry: buildStaveGeometry(s), y: 0, flat: false });
    }
    const hoopMaterial = new MeshStandardMaterial({
      color: shape.hoopColor,
      roughness: 0.6,
      metalness: 0.3,
    });

    for (let i = 0; i < poolSize; i++) {
      const material = new MeshStandardMaterial({
        color: colors.intact,
        roughness: 0.85,
        metalness: 0,
      });
      const mesh = new Mesh(bodyGeometry, material);
      mesh.visible = false;

      // Накладки — ДЕТИ тела, а не отдельные объекты пула: тогда пул по-прежнему
      // двигает и прячет ровно один Mesh на бочку, и про обручи ему знать нечего.
      for (const trim of trims) {
        const part = new Mesh(trim.geometry, hoopMaterial);
        part.position.y = trim.y;
        if (trim.flat) part.rotation.x = -Math.PI / 2;
        mesh.add(part);
      }

      scene.add(mesh);

      this.meshes.push(mesh);
      this.materials.push(material);
    }

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.hp = new Float32Array(poolSize);
    this.maxHp = new Float32Array(poolSize);
    this.flashLeft = new Float32Array(poolSize);
    this.amount = new Float32Array(poolSize);
  }

  get activeCount(): number {
    return this.count;
  }

  get capacity(): number {
    return this.meshes.length;
  }

  /** Сколько бочек разбито выстрелами (бонус выдан). */
  get broken(): number {
    return this.brokenTotal;
  }

  /** Сколько бочек уехало мимо целыми. */
  get dodged(): number {
    return this.dodgedTotal;
  }

  /** Сколько бочек наехало на отряд. */
  get crushed(): number {
    return this.crushedTotal;
  }

  /**
   * Ставит бочку на линию спавна.
   * Без явных аргументов прочность и содержимое выбираются случайно по конфигу.
   */
  spawn(
    x: number,
    content?: BarrelContent,
    hp?: number,
    amount?: number,
    special?: WeaponId,
  ): void {
    if (this.count >= this.capacity) return;

    // Без явного содержимого выбираем из РАЗРЕШЁННОГО прямо сейчас. Если
    // разрешено нечего (начало волны до первых порогов, или все ступени оружия
    // взяты и особое ещё закрыто) — бочка не появляется вовсе.
    const chosenContent = content ?? this.randomContent();
    if (chosenContent === null) return;

    // Порядок важен: прочность зависит и от количества бойцов, и от того, какое
    // именно особое оружие внутри, поэтому и то и другое решается раньше неё.
    const chosenSpecial =
      chosenContent === 'special' ? (special ?? this.randomSpecial()) : null;
    const chosenAmount = amount ?? this.randomAmount(chosenContent);
    const chosenHp = hp ?? this.hpFor(chosenContent, chosenAmount, chosenSpecial);

    const i = this.count++;
    this.posX[i] = x;
    this.posZ[i] = CONFIG.world.spawnZ;
    this.hp[i] = chosenHp;
    this.maxHp[i] = chosenHp;
    // Обнуляем явно: в слоте мог остаться таймер вспышки от прошлой бочки, и
    // новая вышла бы на дорогу уже подсвеченной.
    this.flashLeft[i] = 0;
    this.content[i] = chosenContent;
    this.amount[i] = chosenAmount;
    this.special[i] = chosenSpecial;
  }

  /**
   * Прочность по содержимому: чем ценнее находка, тем дороже её вскрыть.
   * Для стрелков диапазон берётся ЗА КАЖДОГО бойца, поэтому бочка на 5 человек
   * втрое дороже бочки на одного.
   */
  private hpFor(content: BarrelContent, amount: number, special: WeaponId | null): number {
    const ranges = CONFIG.barrels.hpRanges;
    const weapons = ranges.weapons as Record<string, number[] | undefined>;

    switch (content) {
      case 'weapon': {
        const tier = this.nextWeaponTier();
        return BarrelField.randomInRange(weapons[tier ?? ''] ?? ranges.weapons.miniSmg);
      }
      case 'special':
        return BarrelField.randomInRange(weapons[special ?? ''] ?? ranges.weapons.flamethrower);
      case 'shooters':
        return (
          BarrelField.randomInRange(ranges.shootersPerShooter) * Math.max(1, Math.round(amount))
        );
      case 'mine':
        return BarrelField.randomInRange(ranges.mine);
    }
  }

  /** Целое из диапазона [min, max] включительно. */
  private static randomInRange(range: number[]): number {
    const min = range[0] ?? 1;
    const max = range[1] ?? min;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /**
   * Ступень стрелкового оружия, которую выдала бы бочка «оружие», или null,
   * если отряд уже на последней. Разблокировка проверяется именно по ней:
   * бочка обещает конкретный ствол, и обещание должно быть разрешено.
   */
  private nextWeaponTier(): WeaponId | null {
    const chain = CONFIG.weapons.progression as WeaponId[];
    const current = chain.indexOf(this.squad.weaponId);
    if (current < 0 || current >= chain.length - 1) return null;
    return chain[current + 1] ?? null;
  }

  /**
   * Разрешён ли ствол прямо сейчас: куплен в магазине И дожил до своего замка в
   * забеге. Все замки сходятся здесь, в одной функции, — иначе пришлось бы
   * помнить про покупку в каждой из трёх точек выбора содержимого.
   *
   * Замок в забеге двойной (CONFIG.run.unlocks.weapons): номер волны и счёт
   * убийств ТЕКУЩЕЙ волны — по убийствам, а не по секундам, чтобы платный старт
   * с поздней волны не ждал таймер до первой бочки с оружием. Проверяются оба,
   * потому что незаданный замок в аксессорах отдаёт пропускающее значение (1 и 0).
   */
  private isWeaponAllowed(id: WeaponId): boolean {
    if (!this.shop.isWeaponUnlocked(id)) return false;
    if (this.run.waveNumber < weaponUnlockWave(id)) return false;
    return this.run.killedZombies >= weaponUnlockKills(id);
  }

  /**
   * Случайное особое оружие из уже разрешённых — и только из ПОЛЕЗНЫХ отряду
   * прямо сейчас (Squad.specialWeaponBenefits): огнемёт отряду с гранатомётами
   * у всех — пустая трата бочки, такой ствол в неё не кладётся.
   */
  private randomSpecial(): WeaponId {
    const available = (CONFIG.weapons.special as WeaponId[]).filter(
      (id) => this.isWeaponAllowed(id) && this.squad.specialWeaponBenefits(id),
    );
    if (available.length === 0) return randomSpecialWeapon();
    return available[Math.floor(Math.random() * available.length)]!;
  }

  /**
   * Тип содержимого по весам из конфига — но только из РАЗРЕШЁННОГО прямо
   * сейчас и только из ПОЛЕЗНОГО отряду. null — сейчас нечему выпадать,
   * бочку не спавним.
   *
   * Веса берутся от доступных типов, а не нормируются от полного набора: иначе
   * ранний забег выдавал бы «пустые» бочки вместо доступных.
   *
   * БЕСПОЛЕЗНЫЕ бочки не появляются вовсе:
   *   оружие  — отряд уже на последней ступени (nextTier === null) либо следующая
   *             ступень ещё не куплена в магазине / не дожила до своего замка
   *             (волна, счёт убийств). Бочка обещает конкретный ствол, и
   *             обещание, которое нечем исполнить, лучше не показывать.
   *   стрелки — отряд уже упёрся в formation.maxShooters, добавить некого;
   *   особое  — ни один из разрешённых особых стволов никого не усилит
   *             (Squad.specialWeaponBenefits): у всего отряда уже гранатомёты.
   * Проверка стоит на спавне, а не на вскрытии: бесполезную бочку игрок иначе
   * расстреливал бы впустую, а патроны и время в crowd-shooter и есть ресурс.
   *
   * НА СТАРТЕ ИГРЫ, пока не куплен ни один ствол, бочек с оружием и особым не
   * бывает вовсе — остаются только стрелки (мины выключены нулевым весом,
   * CONFIG.barrels.content.mineWeight). Так и задумано: пистолет один до
   * первой покупки в магазине.
   */
  private randomContent(): BarrelContent | null {
    const { weaponWeight, shootersWeight, specialWeight, mineWeight } = CONFIG.barrels.content;
    const unlocks = CONFIG.run.unlocks;

    let total = 0;
    const nextTier = this.nextWeaponTier();
    const weaponOk = nextTier !== null && weaponWeight > 0 && this.isWeaponAllowed(nextTier);
    if (weaponOk) total += weaponWeight;

    const squadHasRoom = this.squad.shooterCount < CONFIG.formation.maxShooters;
    const shootersOk =
      shootersWeight > 0 && squadHasRoom && this.run.isUnlocked(unlocks.barrelShooters);
    if (shootersOk) total += shootersWeight;

    const specialOk =
      specialWeight > 0 &&
      (CONFIG.weapons.special as WeaponId[]).some(
        (id) => this.isWeaponAllowed(id) && this.squad.specialWeaponBenefits(id),
      );
    if (specialOk) total += specialWeight;

    const mineOk = mineWeight > 0 && this.run.isUnlocked(unlocks.barrelMine);
    if (mineOk) total += mineWeight;

    if (total <= 0) return null;

    let roll = Math.random() * total;
    if (weaponOk && (roll -= weaponWeight) < 0) return 'weapon';
    if (shootersOk && (roll -= shootersWeight) < 0) return 'shooters';
    if (specialOk && (roll -= specialWeight) < 0) return 'special';
    return 'mine';
  }

  /**
   * Сколько выдаст содержимое.
   *
   * Для стрелков диапазон ОБРЕЗАЕТСЯ свободными местами в отряде
   * (formation.maxShooters минус текущий размер): бочка обещает конкретное число
   * бойцов, и обещание, которое нечем исполнить, показывать нельзя. Сверх
   * предела бонус всё равно терялся бы в Squad.addShooters — но игрок платил бы
   * за него прочностью (она считается за каждого бойца) и патронами. Так же
   * решается и «оружие»: бесполезная бочка не появляется, а не выдаёт пустоту.
   *
   * Обрезка стоит только на СЛУЧАЙНОМ выборе; явный `amount` из замерочных
   * скриптов проходит как раньше. Ниже 1 не опускается: полное отсутствие мест
   * отсекается ещё в `randomContent`, а при явном `spawn('shooters')` на полном
   * отряде бочка остаётся осмысленной по виду и цене.
   */
  private randomAmount(content: BarrelContent): number {
    if (content === 'mine') return CONFIG.mine.count;
    if (content !== 'shooters') return 1;

    const [min, max] = CONFIG.barrels.content.shooterAmountRange;
    // Потолок режет и верх диапазона, и низ: настройка вида [2, 3] иначе выдала
    // бы двоих на одно свободное место.
    const cap = Math.max(1, CONFIG.formation.maxShooters - this.squad.shooterCount);
    const low = Math.min(min ?? 1, cap);
    const high = Math.max(low, Math.min(max ?? low, cap));
    return low + Math.floor(Math.random() * (high - low + 1));
  }

  /** Движение вниз, контакт с отрядом, уезд за камеру. */
  update(dt: number): void {
    this.spawnStream(dt);

    const { despawnZ } = CONFIG.world;
    const heroRadius = CONFIG.player.heroCapsule.radius;

    // Бочка едет вместе с миром — своей скорости у неё нет. Значит, и на
    // боссфайте она стоит: не доехавшая бочка дождётся конца боя на месте.
    const step = this.run.worldSpeed * dt;
    // Зона контакта: полдиаметра бочки плюс радиус стрелка по Z, поперечный
    // полуразмер плюс радиус по X — лежащая бочка проходит колонну своей длиной.
    const contactZ = barrelSpanZ() / 2 + heroRadius;
    const contactReachX = barrelSpanX() / 2 + heroRadius;
    // Урон при наезде равен урону крупного зомби. Своего числа у бочки нет
    // намеренно: требование задано именно как «в размере урона большого зомби»,
    // и две независимые константы рано или поздно разошлись бы.
    const contactDamage = CONFIG.enemies.big.damagePerHit;
    // Центр по высоте — полвысоты силуэта: у стоящей это половина длины, у
    // лежащей радиус. И та и другая при этом стоят ровно на асфальте.
    const y = barrelSpanY() / 2;
    // Катится бочка по своему самому широкому сечению, то есть по радиусу.
    const rolling = isRolling();
    const rollRadius = CONFIG.barrels.diameter / 2;

    for (let i = 0; i < this.count; ) {
      this.posZ[i]! += step;
      if (this.flashLeft[i]! > 0) this.flashLeft[i]! -= dt;

      // Пока бочка накрывает линию отряда, каждый шаг пробуем задеть стрелков.
      // Задевает ВСЮ полосу шириной хитбокса, а не одного ближайшего: катящаяся
      // бочка идёт сквозь колонну целиком. Промах — это и есть уворот: отряд
      // успел уйти в сторону.
      if (Math.abs(this.posZ[i]!) <= contactZ) {
        if (this.squad.damageShootersInBand(this.posX[i]!, contactReachX, contactDamage) > 0) {
          // Наехала: урон разовый, дальше бочка уходит в пул. Иначе она била бы
          // отряд каждый кадр, пока проезжает сквозь него.
          this.crushedTotal++;
          this.recycle(i);
          continue;
        }
      }

      if (this.posZ[i]! > despawnZ) {
        // Уехала целой — бонус не выдан (ТЗ: пропущенный бонус вернуть нельзя).
        this.dodgedTotal++;
        this.recycle(i);
        continue;
      }

      const mesh = this.meshes[i]!;
      mesh.visible = true;
      mesh.position.set(this.posX[i]!, y, this.posZ[i]!);
      // Поворот ставится каждый кадр целиком, а не один раз при создании:
      // тогда стиль переключается на живой игре, без пересборки поля.
      //
      // Лежащую бочку кладёт набок rotation.z: ось тела вращения (своя y) уходит
      // поперёк дороги. Порядок поворотов у three — XYZ, то есть rotation.z
      // применяется ПЕРВЫМ, а rotation.x после него, уже вокруг мировой оси X.
      // Поэтому качение — это именно rotation.x, и бочка вращается вокруг
      // собственной оси, а не заваливается набок ещё раз.
      //
      // Угол качения считается от ПРОЙДЕННОГО пути, а не накоплением по dt:
      // отдельного массива под угол не нужно (значит, и переноса в recycle),
      // качение точно совпадает с движением при любом dt, а на боссфайте
      // останавливается вместе с дорогой само собой. Вращение вокруг +X уводит
      // верхнюю точку в +Z — то есть бочка катится НА отряд.
      const roll = rolling ? (this.posZ[i]! - CONFIG.world.spawnZ) / rollRadius : 0;
      mesh.rotation.set(roll, 0, rolling ? Math.PI / 2 : 0);
      this.materials[i]!.color.copy(this.colorFor(i));

      i++;
    }

    for (let i = this.count; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
    }
  }

  /**
   * Попадание пули на отрезке её полёта за шаг (передаётся в BulletPool.update).
   *
   * Бочка считается кругом в плоскости XZ радиусом в половину ПОПЕРЕЧНОГО
   * размера. У стоящей это точно её сечение: тело вращения и есть круг. У
   * лежащей след на дороге — прямоугольник 1.4 × 1.2, но пули летят почти вдоль
   * Z, поэтому важно, при каких x попадание засчитывается: по x круг совпадает
   * с фигурой точно, а по z ошибается максимум на 0.1 units (пуля попадает чуть
   * раньше, чем коснулась бы бока).
   *
   * Поверх габарита стоит hitboxScale — круг попаданий шире модели, как у зомби
   * (см. CONFIG.barrels.hitboxScale). Наезда и взрыва это не касается: там
   * по-прежнему настоящий размер.
   */
  readonly tryHit = (
    xFrom: number,
    zFrom: number,
    xTo: number,
    zTo: number,
    damage: number,
    bulletRadius: number = CONFIG.weapons.bullet.radius,
    pierce = false,
  ): boolean => {
    const reach = (barrelSpanX() / 2) * CONFIG.barrels.hitboxScale + bulletRadius;
    let anyHit = false;

    for (let i = 0; i < this.count; ) {
      const touched = pierce
        ? segmentPassesCircle(this.posX[i]!, this.posZ[i]!, reach, xFrom, zFrom, xTo, zTo)
        : segmentHitsCircle(this.posX[i]!, this.posZ[i]!, reach, xFrom, zFrom, xTo, zTo);

      if (!touched) {
        i++;
        continue;
      }

      if (!pierce) {
        this.applyDamage(i, damage);
        return true;
      }

      anyHit = true;
      if (this.applyDamage(i, damage)) continue; // разбилась — в слот переехала другая
      i++;
    }

    return anyHit;
  };

  /**
   * Наносит урон бочке i. Возвращает true, если она разбилась (и в её слот уже
   * переехала последняя активная бочка).
   *
   * Единственная воронка урона по бочкам: и выстрелы, и взрывы мин идут через
   * неё, поэтому сопротивление урону применяется в одном месте.
   */
  private applyDamage(i: number, damage: number): boolean {
    this.hp[i]! -= damage * CONFIG.barrels.damageResistance;
    // Вспышка ставится здесь же, после изменения HP: воронка одна на выстрелы и
    // взрывы, значит подсветятся оба источника урона.
    this.flashLeft[i] = CONFIG.ui.damageFlash.seconds;
    if (this.hp[i]! > 0) return false;

    this.breakBarrel(i);
    return true;
  }

  /**
   * Урон по площади (взрыв мины, ТЗ: «по всем зомби и объектам в зоне»).
   * Разбитая взрывом бочка отдаёт содержимое так же, как разбитая выстрелами.
   * Возвращает число задетых бочек.
   */
  damageInRadius(x: number, z: number, radius: number, damage: number): number {
    const reach = radius + barrelSpanX() / 2;
    const reachSq = reach * reach;
    let hit = 0;

    for (let i = 0; i < this.count; ) {
      const dx = this.posX[i]! - x;
      const dz = this.posZ[i]! - z;

      if (dx * dx + dz * dz > reachSq) {
        i++;
        continue;
      }

      hit++;
      // i не увеличиваем при разрушении: в этот слот переехала последняя активная бочка.
      if (this.applyDamage(i, damage)) continue;

      i++;
    }

    return hit;
  }

  /**
   * Разрушение бочки: содержимое отряду, кристалл EXP на землю, слот в пул.
   * Один метод на выстрел и на взрыв мины — иначе награда за них разъехалась бы.
   */
  private breakBarrel(i: number): void {
    this.applyContent(this.content[i]!, this.amount[i]!, this.special[i] ?? null);
    this.crystals.spawn(this.posX[i]!, this.posZ[i]!, CONFIG.exp.perBarrel);
    this.brokenTotal++;
    this.recycle(i);
  }

  /** Отдаёт содержимое разбитой бочки отряду. */
  private applyContent(content: BarrelContent, amount: number, special: WeaponId | null): void {
    switch (content) {
      case 'weapon':
        this.squad.upgradeSquadWeapon();
        break;
      case 'shooters':
        this.squad.addShooters(Math.max(1, Math.round(amount)));
        break;
      case 'special': {
        const id = special ?? randomSpecialWeapon();
        // Отметка только по фактической выдаче: ствол, который никому не
        // достался (null), игрок в руках не держал — аренду он не открывает.
        if (this.squad.giveSpecialWeapon(id) !== null) this.shop.markSpecialPicked(id);
        break;
      }
      case 'mine':
        this.squad.deployMines(Math.max(1, Math.round(amount)));
        break;
    }
  }

  /**
   * Перечисляет бочки как препятствия для обхода зомби (ObstacleField из
   * enemies.ts). След — настоящий габарит, без hitboxScale: обход должен
   * начинаться у борта бочки, а не у расширенного круга попаданий пуль.
   */
  forEachObstacle(
    visit: (x: number, z: number, halfX: number, halfZ: number) => void,
  ): void {
    const halfX = barrelSpanX() / 2;
    const halfZ = barrelSpanZ() / 2;
    for (let i = 0; i < this.count; i++) {
      visit(this.posX[i]!, this.posZ[i]!, halfX, halfZ);
    }
  }

  /**
   * Перечисляет бочки для подписей: число прочности и иконка содержимого.
   * Отдельный обход, чтобы UI не лазил во внутренние массивы.
   */
  forEachLabel(
    visit: (x: number, y: number, z: number, value: string, icon: string, variant: string) => void,
  ): void {
    const labelY = CONFIG.barrels.labelY;
    // Ступень одна на все бочки — оружие у отряда общее, считаем её один раз.
    const tier = this.nextWeaponTier();

    for (let i = 0; i < this.count; i++) {
      visit(
        this.posX[i]!,
        labelY,
        this.posZ[i]!,
        String(Math.ceil(this.hp[i]!)),
        contentIcon(this.content[i]!, Math.round(this.amount[i]!), this.special[i] ?? null, tier),
        this.variantFor(i),
      );
    }
  }

  /** Состояние прочности: intact → cracked50 → cracked25 (ТЗ раздел 7). */
  private variantFor(i: number): BarrelVariant {
    const [half, quarter] = CONFIG.barrels.crackThresholds;
    const fraction = this.hp[i]! / this.maxHp[i]!;

    if (fraction <= (quarter ?? 0.25)) return 'cracked25';
    if (fraction <= (half ?? 0.5)) return 'cracked50';
    return 'intact';
  }

  /**
   * Цвет тела бочки на этот кадр: состояние трещин, а поверх него — вспышка
   * от только что полученного урона, как у зомби, босса и отряда.
   */
  private colorFor(i: number): Color {
    const variant = this.variantFor(i);
    return this.flashLeft[i]! > 0 ? this.flashColors[variant] : this.bodyColors[variant];
  }

  private spawnStream(dt: number): void {
    const { interval, lateralSpreadPercent } = CONFIG.barrels.spawn;
    if (!this.spawnEnabled || interval <= 0) return;

    this.spawnTimer += dt;

    // На экране допустим только один бонус (бочка или ворота). Пока он там,
    // подошедший тик НЕ расходуется: таймер держим у порога, и новая бочка
    // выходит в первый же кадр после того, как экран освободился. Пропускать
    // тик было бы проще, но тогда к занятости экрана добавлялось бы ещё до
    // interval секунд пустой дороги.
    if (!this.bonusSlot.isFree && this.spawnTimer > interval) this.spawnTimer = interval;

    // isFree в условии цикла, а не только перед ним: иначе накопленный таймер
    // выпустил бы за один кадр сразу две бочки.
    while (this.spawnTimer >= interval && this.bonusSlot.isFree) {
      this.spawnTimer -= interval;
      const spread = (CONFIG.world.roadWidth / 2) * (lateralSpreadPercent / 100);
      this.spawn((Math.random() * 2 - 1) * spread);
    }
  }

  /** Чистит поле и статистику забега. */
  reset(): void {
    this.count = 0;
    this.spawnTimer = 0;
    this.spawnEnabled = true;
    this.brokenTotal = 0;
    this.dodgedTotal = 0;
    this.crushedTotal = 0;
    for (const mesh of this.meshes) mesh.visible = false;
  }

  /** Убирает бочку i, переставляя на её место последнюю активную. */
  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.hp[i] = this.hp[last]!;
      this.maxHp[i] = this.maxHp[last]!;
      this.flashLeft[i] = this.flashLeft[last]!;
      this.content[i] = this.content[last]!;
      this.amount[i] = this.amount[last]!;
      this.special[i] = this.special[last] ?? null;
    }

    this.count--;
    this.meshes[this.count]!.visible = false;
  }

  /** Состояние бочек — для отладки и проверок. */
  debugSnapshot(): Array<{
    x: number;
    z: number;
    hp: number;
    maxHp: number;
    flashLeft: number;
    variant: string;
    content: BarrelContent;
    amount: number;
    special: WeaponId | null;
    icon: string;
  }> {
    const out = [];
    const tier = this.nextWeaponTier();
    for (let i = 0; i < this.count; i++) {
      const amount = Math.round(this.amount[i]!);
      const special = this.special[i] ?? null;
      out.push({
        x: this.posX[i]!,
        z: this.posZ[i]!,
        hp: this.hp[i]!,
        maxHp: this.maxHp[i]!,
        flashLeft: this.flashLeft[i]!,
        variant: this.variantFor(i),
        content: this.content[i]!,
        amount,
        special,
        icon: contentIcon(this.content[i]!, amount, special, tier),
      });
    }
    return out;
  }
}
