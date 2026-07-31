import { BoxGeometry, Mesh, MeshStandardMaterial, type Scene } from 'three';
import { CONFIG } from '../config';
import { segmentHitsCircle } from '../core/collision';
import type { RunState } from '../core/run';
import type { CrystalPool } from './crystals';
import type { SquadTarget } from './enemies';
import { randomSpecialWeapon, type WeaponId } from './weapons';

/** Что лежит в бочке (ТЗ раздел 7). */
export type BarrelContent = 'weapon' | 'shooters' | 'special' | 'mine';

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
  giveSpecialWeapon(id: WeaponId): 'hero' | 'ally';

  /** Расставляет противопехотные мины перед отрядом (ТЗ раздел 7). */
  deployMines(count?: number): void;

  /** Наезд бочки: урон всем стрелкам в полосе шириной хитбокса. */
  damageShootersInBand(centerX: number, halfWidth: number, damage: number): number;
}

/** Иконки особого оружия — по ним видно, что именно лежит в бочке. */
const SPECIAL_ICONS: Partial<Record<WeaponId, string>> = {
  flamethrower: '🔥',
  grenadeLauncher: '💥',
};

/**
 * Иконка содержимого над бочкой (ТЗ раздел 7).
 *
 * Для стрелков ТЗ задаёт особое правило: до 4 — просто N фигурок, свыше —
 * 4 фигурки и множитель «×N» поверх, иначе десяток фигурок не читается.
 */
function contentIcon(content: BarrelContent, amount: number, special: WeaponId | null): string {
  if (content === 'weapon') return '🔫';
  if (content === 'mine') return '💣';
  if (content === 'special') return (special !== null ? SPECIAL_ICONS[special] : undefined) ?? '✨';

  const { iconFigureLimit } = CONFIG.barrels.content;
  if (amount <= iconFigureLimit) return '🧍'.repeat(Math.max(1, amount));

  return `${'🧍'.repeat(iconFigureLimit)}×${amount}`;
}

/**
 * Бочки-бонусы (ТЗ раздел 7).
 *
 * Едут сверху вниз вместе с миром. Над бочкой — число прочности; попадания его
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

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  private readonly hp: Float32Array;
  private readonly maxHp: Float32Array;
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
  ) {
    const { size, poolSize, colors } = CONFIG.barrels;

    // Геометрия одна на все бочки, материал — свой на каждую (нужен свой цвет).
    const geometry = new BoxGeometry(size.x, size.y, size.z);

    for (let i = 0; i < poolSize; i++) {
      const material = new MeshStandardMaterial({
        color: colors.intact,
        roughness: 0.85,
        metalness: 0,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      scene.add(mesh);

      this.meshes.push(mesh);
      this.materials.push(material);
    }

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.hp = new Float32Array(poolSize);
    this.maxHp = new Float32Array(poolSize);
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

    // Без явного содержимого выбираем из РАЗРЕШЁННОГО на этой секунде забега.
    // Если разрешено нечего (первые 20 секунд, или все ступени оружия взяты и
    // особое ещё закрыто) — бочка не появляется вовсе.
    const chosenContent = content ?? this.randomContent();
    if (chosenContent === null) return;

    // Порядок важен: прочность зависит и от количества бойцов, и от того, какое
    // именно особое оружие внутри, поэтому и то и другое решается раньше неё.
    const chosenSpecial =
      chosenContent === 'special' ? (special ?? this.randomSpecial()) : null;
    const chosenAmount = amount ?? BarrelField.randomAmount(chosenContent);
    const chosenHp = hp ?? this.hpFor(chosenContent, chosenAmount, chosenSpecial);

    const i = this.count++;
    this.posX[i] = x;
    this.posZ[i] = CONFIG.world.spawnZ;
    this.hp[i] = chosenHp;
    this.maxHp[i] = chosenHp;
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

  /** Разрешено ли особое оружие id на этой секунде забега. */
  private isSpecialUnlocked(id: WeaponId): boolean {
    const unlocks = CONFIG.run.unlocks.weapons as Record<string, number | undefined>;
    const at = unlocks[id];
    return at === undefined || this.run.isUnlocked(at);
  }

  /** Случайное особое оружие из уже разблокированных. */
  private randomSpecial(): WeaponId {
    const available = (CONFIG.weapons.special as WeaponId[]).filter((id) =>
      this.isSpecialUnlocked(id),
    );
    if (available.length === 0) return randomSpecialWeapon();
    return available[Math.floor(Math.random() * available.length)]!;
  }

  /**
   * Тип содержимого по весам из конфига — но только из РАЗРЕШЁННОГО на этой
   * секунде забега и только из ПОЛЕЗНОГО отряду прямо сейчас. null — сейчас
   * нечему выпадать, бочку не спавним.
   *
   * Веса берутся от доступных типов, а не нормируются от полного набора: иначе
   * ранний забег выдавал бы «пустые» бочки вместо доступных.
   *
   * БЕСПОЛЕЗНЫЕ бочки не появляются вовсе:
   *   оружие  — отряд уже на последней ступени (nextTier === null) либо следующая
   *             ступень ещё закрыта по времени. Бочка обещает конкретный ствол, и
   *             обещание, которое нечем исполнить, лучше не показывать.
   *   стрелки — отряд уже упёрся в formation.maxShooters, добавить некого.
   * Проверка стоит на спавне, а не на вскрытии: бесполезную бочку игрок иначе
   * расстреливал бы впустую, а патроны и время в crowd-shooter и есть ресурс.
   */
  private randomContent(): BarrelContent | null {
    const { weaponWeight, shootersWeight, specialWeight, mineWeight } = CONFIG.barrels.content;
    const unlocks = CONFIG.run.unlocks;

    let total = 0;
    const nextTier = this.nextWeaponTier();
    const weaponUnlocks = unlocks.weapons as Record<string, number | undefined>;
    const weaponOk =
      nextTier !== null &&
      weaponWeight > 0 &&
      this.run.isUnlocked(weaponUnlocks[nextTier] ?? 0);
    if (weaponOk) total += weaponWeight;

    const squadHasRoom = this.squad.shooterCount < CONFIG.formation.maxShooters;
    const shootersOk =
      shootersWeight > 0 && squadHasRoom && this.run.isUnlocked(unlocks.barrelShooters);
    if (shootersOk) total += shootersWeight;

    const specialOk =
      specialWeight > 0 && (CONFIG.weapons.special as WeaponId[]).some((id) => this.isSpecialUnlocked(id));
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

  private static randomAmount(content: BarrelContent): number {
    if (content === 'mine') return CONFIG.mine.count;
    if (content !== 'shooters') return 1;

    const [min, max] = CONFIG.barrels.content.shooterAmountRange;
    const low = min ?? 1;
    const high = max ?? low;
    return low + Math.floor(Math.random() * (high - low + 1));
  }

  /** Движение вниз, контакт с отрядом, уезд за камеру. */
  update(dt: number): void {
    this.spawnStream(dt);

    const { size } = CONFIG.barrels;
    const { worldSpeed, despawnZ } = CONFIG.world;
    const heroRadius = CONFIG.player.heroCapsule.radius;

    // Бочка «катится» вместе с миром — своей скорости у неё нет.
    const step = worldSpeed * dt;
    // Зона контакта: полглубины бочки плюс радиус стрелка.
    const contactZ = size.z / 2 + heroRadius;
    const contactReachX = size.x / 2 + heroRadius;
    // Урон при наезде равен урону крупного зомби. Своего числа у бочки нет
    // намеренно: требование задано именно как «в размере урона большого зомби»,
    // и две независимые константы рано или поздно разошлись бы.
    const contactDamage = CONFIG.enemies.big.damagePerHit;
    const y = size.y / 2;

    for (let i = 0; i < this.count; ) {
      this.posZ[i]! += step;

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
      this.materials[i]!.color.setHex(this.colorFor(i));

      i++;
    }

    for (let i = this.count; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
    }
  }

  /**
   * Попадание пули на отрезке её полёта за шаг (передаётся в BulletPool.update).
   * Бочка считается кругом в плоскости XZ — для бокса 1.2×1.2 разница
   * незаметна, а проверка остаётся такой же дешёвой, как у зомби.
   */
  readonly tryHit = (
    xFrom: number,
    zFrom: number,
    xTo: number,
    zTo: number,
    damage: number,
  ): boolean => {
    const reach = CONFIG.barrels.size.x / 2 + CONFIG.weapons.bullet.radius;

    for (let i = 0; i < this.count; i++) {
      if (!segmentHitsCircle(this.posX[i]!, this.posZ[i]!, reach, xFrom, zFrom, xTo, zTo)) {
        continue;
      }

      this.hp[i]! -= damage;
      if (this.hp[i]! <= 0) this.breakBarrel(i);
      return true;
    }

    return false;
  };

  /**
   * Урон по площади (взрыв мины, ТЗ: «по всем зомби и объектам в зоне»).
   * Разбитая взрывом бочка отдаёт содержимое так же, как разбитая выстрелами.
   * Возвращает число задетых бочек.
   */
  damageInRadius(x: number, z: number, radius: number, damage: number): number {
    const reach = radius + CONFIG.barrels.size.x / 2;
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
      this.hp[i]! -= damage;
      if (this.hp[i]! <= 0) {
        this.breakBarrel(i);
        // i не увеличиваем: в этот слот переехала последняя активная бочка.
        continue;
      }

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
      case 'special':
        this.squad.giveSpecialWeapon(special ?? randomSpecialWeapon());
        break;
      case 'mine':
        this.squad.deployMines(Math.max(1, Math.round(amount)));
        break;
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

    for (let i = 0; i < this.count; i++) {
      visit(
        this.posX[i]!,
        labelY,
        this.posZ[i]!,
        String(Math.ceil(this.hp[i]!)),
        contentIcon(this.content[i]!, Math.round(this.amount[i]!), this.special[i] ?? null),
        this.variantFor(i),
      );
    }
  }

  /** Состояние прочности: intact → cracked50 → cracked25 (ТЗ раздел 7). */
  private variantFor(i: number): 'intact' | 'cracked50' | 'cracked25' {
    const [half, quarter] = CONFIG.barrels.crackThresholds;
    const fraction = this.hp[i]! / this.maxHp[i]!;

    if (fraction <= (quarter ?? 0.25)) return 'cracked25';
    if (fraction <= (half ?? 0.5)) return 'cracked50';
    return 'intact';
  }

  private colorFor(i: number): number {
    const { colors } = CONFIG.barrels;

    switch (this.variantFor(i)) {
      case 'cracked25':
        return colors.cracked25;
      case 'cracked50':
        return colors.cracked50;
      default:
        return colors.intact;
    }
  }

  private spawnStream(dt: number): void {
    const { interval, lateralSpreadPercent } = CONFIG.barrels.spawn;
    if (!this.spawnEnabled || interval <= 0) return;

    this.spawnTimer += dt;
    while (this.spawnTimer >= interval) {
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
    variant: string;
    content: BarrelContent;
    amount: number;
    special: WeaponId | null;
    icon: string;
  }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const amount = Math.round(this.amount[i]!);
      const special = this.special[i] ?? null;
      out.push({
        x: this.posX[i]!,
        z: this.posZ[i]!,
        hp: this.hp[i]!,
        maxHp: this.maxHp[i]!,
        variant: this.variantFor(i),
        content: this.content[i]!,
        amount,
        special,
        icon: contentIcon(this.content[i]!, amount, special),
      });
    }
    return out;
  }
}
