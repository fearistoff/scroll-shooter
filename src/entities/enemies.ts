import {
  CapsuleGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import { segmentHitsCircle } from '../core/collision';
import type { RunState, ZombieKind } from '../core/run';
import type { CrystalPool } from './crystals';

/**
 * То, по чему бьют зомби. В слое 3 это был один герой, теперь весь отряд,
 * и логика «кто ближайший» живёт у отряда.
 */
export interface SquadTarget {
  /**
   * Всего стрелков, включая «невидимых» за визуальным потолком.
   * По нему ускоряется поток зомби: сложность идёт за силой игрока.
   */
  readonly shooterCount: number;

  /**
   * Наносит урон ближайшему стрелку.
   *
   * Досягаемость проверяется по горизонтали (reachX): нападающий уже стоит на
   * линии перед отрядом, то есть по глубине заведомо достаёт. Координата fromZ
   * нужна не для отбора, а для выбора цели среди попавших в полосу — ближайшим
   * по фактическому расстоянию оказывается передний ряд.
   *
   * Возвращает true, если удар кого-то достал.
   */
  damageNearestShooter(fromX: number, fromZ: number, amount: number, reachX: number): boolean;
}

/**
 * Зомби обоих видов (ТЗ раздел 9): обычные и крупные.
 *
 * Оба вида живут в ОДНОМ пуле: движение, остановка на линии, удары и попадания
 * у них одинаковые, различаются только HP, урон, габарит и цвет. Разными
 * остаются лишь InstancedMesh — по одному на вид, потому что геометрия капсулы
 * у них разного размера.
 *
 * Данные в Float32Array, гашение через swap-remove, активные непрерывно
 * в [0, count) — как у пуль и кристаллов.
 */
export class EnemyPool {
  private readonly normalMesh: InstancedMesh;
  private readonly bigMesh: InstancedMesh;
  private readonly matrix = new Matrix4();

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  private readonly hp: Float32Array;
  private readonly attackTimer: Float32Array;
  /** Своя линия остановки у каждого — толпа не выстраивается в стену. */
  private readonly stopAt: Float32Array;
  /** 1 — крупный зомби, 0 — обычный. */
  private readonly isBig: Uint8Array;
  /**
   * Сколько секунд ещё показывать полоску HP. Ставится при уроне, убывает по
   * ИГРОВОМУ dt — на паузе между забегами полоски не тают.
   */
  private readonly hpBarLeft: Float32Array;

  private count = 0;
  private spawnTimer = 0;
  /** Первый зомби забега выходит сразу, а не через интервал. Ставится в reset. */
  private primeFirstSpawn = true;

  /**
   * Выключатель потока. Раньше спавн глушился через interval <= 0, но с разгоном
   * интервал считается из рампы, и такой способ перестал работать. Поле — как у
   * BarrelField и GateField.
   */
  spawnEnabled = true;

  private killedTotal = 0;
  private spawnedTotal = 0;
  private bigSpawnedTotal = 0;

  constructor(
    scene: Scene,
    private readonly run: RunState,
    private readonly crystals: CrystalPool,
  ) {
    const { normal, big, poolSize } = CONFIG.enemies;

    this.normalMesh = EnemyPool.createMesh(scene, normal.capsule, normal.color, poolSize);
    this.bigMesh = EnemyPool.createMesh(scene, big.capsule, big.color, poolSize);

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.hp = new Float32Array(poolSize);
    this.attackTimer = new Float32Array(poolSize);
    this.stopAt = new Float32Array(poolSize);
    this.isBig = new Uint8Array(poolSize);
    this.hpBarLeft = new Float32Array(poolSize);
  }

  private static createMesh(
    scene: Scene,
    capsule: { radius: number; length: number },
    color: number,
    poolSize: number,
  ): InstancedMesh {
    const mesh = new InstancedMesh(
      new CapsuleGeometry(capsule.radius, capsule.length, 4, 10),
      new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 }),
      poolSize,
    );
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Инстансы движутся, а bounding sphere меша не пересчитывается: без этого
    // сетка может целиком отсечься по фрустуму и пропасть.
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);
    return mesh;
  }

  get activeCount(): number {
    return this.count;
  }

  get capacity(): number {
    return this.posX.length;
  }

  get killed(): number {
    return this.killedTotal;
  }

  get spawned(): number {
    return this.spawnedTotal;
  }

  get bigSpawned(): number {
    return this.bigSpawnedTotal;
  }

  /** Сколько крупных зомби сейчас на поле. */
  get bigActiveCount(): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.isBig[i] === 1) total++;
    }
    return total;
  }

  /** Ставит зомби на линию спавна. Если пул полон — спавн пропускается. */
  spawn(x: number, kind: ZombieKind = 'normal'): void {
    if (this.count >= this.capacity) return;

    const { stopZ, stopLineJitter, attackInterval, firstAttackDelay } = CONFIG.enemies;
    const stats = kind === 'big' ? CONFIG.enemies.big : CONFIG.enemies.normal;
    const i = this.count++;

    this.posX[i] = x;
    this.posZ[i] = CONFIG.world.spawnZ;
    this.hp[i] = stats.hp;
    // Атака начинается с паузы: таймер копится только после того, как зомби дошёл
    // до линии остановки, поэтому первый удар прилетает через firstAttackDelay
    // ПОСЛЕ прибытия, а не в тот же кадр. Раньше здесь стоял attackInterval, то
    // есть таймер приходил уже полным и бил мгновенно.
    this.attackTimer[i] = attackInterval - firstAttackDelay;
    this.stopAt[i] = stopZ - Math.random() * stopLineJitter;
    this.isBig[i] = kind === 'big' ? 1 : 0;
    // Обязательно обнуляем: в этот слот мог попасть таймер убитого зомби, и
    // новый мигнул бы полоской, не получив урона.
    this.hpBarLeft[i] = 0;

    this.spawnedTotal++;
    if (kind === 'big') this.bigSpawnedTotal++;
  }

  /** Поток сверху, движение к отряду, остановка на линии и удары. */
  update(dt: number, squad: SquadTarget): void {
    this.spawnStream(dt, squad);

    const { normal, big, extraSpeed, attackInterval, attackReachX } = CONFIG.enemies;
    const { worldSpeed, despawnZ } = CONFIG.world;
    // Зомби идут сами плюс их несёт наезжающий мир.
    const step = (worldSpeed + extraSpeed) * dt;

    let normalDrawn = 0;
    let bigDrawn = 0;

    for (let i = 0; i < this.count; ) {
      const bigOne = this.isBig[i] === 1;
      const stats = bigOne ? big : normal;

      if (this.hpBarLeft[i]! > 0) this.hpBarLeft[i]! -= dt;

      if (this.posZ[i]! < this.stopAt[i]!) {
        // Ещё идёт. Не перескакиваем линию остановки за шаг.
        this.posZ[i] = Math.min(this.posZ[i]! + step, this.stopAt[i]!);
      } else {
        // Дошёл: бьёт ближайшего стрелка с периодом attackInterval.
        this.attackTimer[i]! += dt;
        if (this.attackTimer[i]! >= attackInterval) {
          this.attackTimer[i]! -= attackInterval;
          squad.damageNearestShooter(
            this.posX[i]!,
            this.posZ[i]!,
            stats.damagePerHit,
            attackReachX,
          );
        }
      }

      // Страховка: за камеру зомби уходить не должен, но если уйдёт — в пул.
      if (this.posZ[i]! > despawnZ) {
        this.recycle(i);
        continue;
      }

      const y = stats.capsule.length / 2 + stats.capsule.radius;
      this.matrix.makeTranslation(this.posX[i]!, y, this.posZ[i]!);
      if (bigOne) {
        this.bigMesh.setMatrixAt(bigDrawn++, this.matrix);
      } else {
        this.normalMesh.setMatrixAt(normalDrawn++, this.matrix);
      }

      i++;
    }

    this.normalMesh.count = normalDrawn;
    this.bigMesh.count = bigDrawn;
    this.normalMesh.instanceMatrix.needsUpdate = true;
    this.bigMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Попадание пули на отрезке её полёта за шаг (передаётся в BulletPool.update).
   * Отрезок произвольного направления: во время боссфайта пули идут по диагонали.
   * Габарит берётся по виду зомби.
   */
  readonly tryHit = (
    xFrom: number,
    zFrom: number,
    xTo: number,
    zTo: number,
    damage: number,
  ): boolean => {
    const bulletRadius = CONFIG.weapons.bullet.radius;
    // Хитбокс шире модели: попадания считаются по увеличенному радиусу, а капсула
    // рисуется прежнего размера.
    const hitboxScale = CONFIG.enemies.hitboxScale;

    for (let i = 0; i < this.count; i++) {
      const reach =
        (this.isBig[i] === 1 ? CONFIG.enemies.big : CONFIG.enemies.normal).capsule.radius *
          hitboxScale +
        bulletRadius;

      if (!segmentHitsCircle(this.posX[i]!, this.posZ[i]!, reach, xFrom, zFrom, xTo, zTo)) {
        continue;
      }

      this.applyDamage(i, damage);
      return true;
    }

    return false;
  };

  /** Есть ли живой зомби в круге — по этому взводится детонация мин. */
  hasEnemyInRadius(x: number, z: number, radius: number): boolean {
    const radiusSq = radius * radius;

    for (let i = 0; i < this.count; i++) {
      const dx = this.posX[i]! - x;
      const dz = this.posZ[i]! - z;
      if (dx * dx + dz * dz <= radiusSq) return true;
    }

    return false;
  }

  /**
   * Урон по площади (взрыв мины, ТЗ раздел 7). Возвращает число задетых зомби.
   * Урон фиксированный, поэтому крупный зомби с 30 hp взрыв на 20 переживает.
   */
  damageInRadius(x: number, z: number, radius: number, damage: number): number {
    const radiusSq = radius * radius;
    let hit = 0;

    for (let i = 0; i < this.count; ) {
      const dx = this.posX[i]! - x;
      const dz = this.posZ[i]! - z;

      if (dx * dx + dz * dz > radiusSq) {
        i++;
        continue;
      }

      hit++;
      if (this.applyDamage(i, damage)) continue; // погиб — в слот переехал другой
      i++;
    }

    return hit;
  }

  /*
   * Подписей HP у зомби НЕТ. Раньше над крупным зомби всегда висело число (ТЗ
   * раздел 9), но по решению запас врага показывают только полоски, поэтому
   * forEachLabel у пула зомби удалён вместе с enemies.hpLabelOffsetY.
   *
   * Следствие, о котором стоит помнить: полоска появляется лишь на
   * ui.hpBar.showSeconds после урона, значит у крупного зомби, пока в него не
   * попали, индикатора нет вообще.
   */

  /**
   * Перечисляет полоски HP: только те зомби, что получали урон в последние
   * ui.hpBar.showSeconds секунд. Босса здесь нет — он вообще не зомби, у него
   * своя многослойная полоса в HUD.
   */
  forEachHpBar(visit: (x: number, y: number, z: number, fraction: number) => void): void {
    const { normal, big } = CONFIG.enemies;
    const offsetY = CONFIG.ui.hpBar.offsetY;

    for (let i = 0; i < this.count; i++) {
      if (this.hpBarLeft[i]! <= 0) continue;

      const stats = this.isBig[i] === 1 ? big : normal;
      const top = stats.capsule.length + stats.capsule.radius * 2;
      visit(this.posX[i]!, top + offsetY, this.posZ[i]!, this.hp[i]! / stats.hp);
    }
  }

  /** Сколько полосок HP сейчас показано — для отладки и проверок. */
  get hpBarsVisible(): number {
    let total = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.hpBarLeft[i]! > 0) total++;
    }
    return total;
  }

  /** Наносит урон зомби i. Возвращает true, если он погиб. */
  private applyDamage(i: number, damage: number): boolean {
    this.hp[i]! -= damage;
    // Единственная воронка урона по зомби (попадание пули и взрыв мины идут
    // через неё), поэтому таймер полоски ставится здесь и только здесь.
    this.hpBarLeft[i] = CONFIG.ui.hpBar.showSeconds;
    if (this.hp[i]! > 0) return false;

    // Кристалл падает там, где зомби погиб; крупный стоит дороже (ТЗ раздел 9).
    const value = this.isBig[i] === 1 ? CONFIG.exp.perBigZombie : CONFIG.exp.perNormalZombie;
    this.crystals.spawn(this.posX[i]!, this.posZ[i]!, value);

    this.recycle(i);
    this.killedTotal++;
    this.run.registerZombieKill();
    return true;
  }

  /**
   * Текущий интервал между зомби: разгон по времени забега плюс ускорение от
   * размера отряда.
   *
   * Разгон линейно сжимает интервал от startInterval к endInterval за
   * ramp.seconds забега, дальше держит на минимуме. Считается от времени забега,
   * а не от остатка бюджета: давление должно расти независимо от того, успевает
   * игрок или нет.
   *
   * Отряд делит интервал на 1 + squadScale × (стрелков − 1) — чем больше стволов
   * собрал игрок, тем плотнее толпа.
   *
   * Номер волны делит интервал ещё раз, на run.spawnRateMultiplier: каждая волна
   * после босса идёт плотнее предыдущей (CONFIG.run.waveSpawnRateGrowth). Все три
   * множителя сходятся здесь, в одной функции, — иначе их взаимное влияние
   * пришлось бы искать по трём файлам.
   */
  spawnInterval(shooterCount = 1): number {
    const { interval, ramp, squadScale } = CONFIG.enemies.spawn;

    let base = interval;
    if (ramp.enabled) {
      const progress = ramp.seconds > 0 ? Math.min(this.run.elapsedSeconds / ramp.seconds, 1) : 1;
      base = ramp.startInterval + (ramp.endInterval - ramp.startInterval) * progress;
    }

    const squadFactor = 1 + squadScale * Math.max(0, shooterCount - 1);
    return base / (squadFactor * this.run.spawnRateMultiplier);
  }

  private spawnStream(dt: number, squad: SquadTarget): void {
    const { lateralSpreadPercent } = CONFIG.enemies.spawn;
    const interval = this.spawnInterval(squad.shooterCount);
    if (!this.spawnEnabled || interval <= 0) return;

    // Первого зомби забега выпускаем сразу, не выжидая интервал: он и так идёт до
    // зоны огня 4 секунды, а с ожиданием интервала (1.6 с у одиночки) пустая
    // дорога тянулась 5.5 секунды.
    if (this.primeFirstSpawn) {
      this.spawnTimer = interval;
      this.primeFirstSpawn = false;
    }

    this.spawnTimer += dt;
    while (this.spawnTimer >= interval) {
      this.spawnTimer -= interval;

      // Вид и сам факт спавна решает забег: бюджет волны конечен.
      const kind = this.run.takeNextZombie();
      if (kind === null) return;

      const spread = (CONFIG.world.roadWidth / 2) * (lateralSpreadPercent / 100);
      this.spawn((Math.random() * 2 - 1) * spread, kind);
    }
  }

  /** Чистит поле и статистику: новый забег начинается с пустой дороги. */
  reset(): void {
    this.count = 0;
    this.spawnTimer = 0;
    this.primeFirstSpawn = true;
    this.spawnEnabled = true;
    this.killedTotal = 0;
    this.spawnedTotal = 0;
    this.bigSpawnedTotal = 0;
    this.normalMesh.count = 0;
    this.bigMesh.count = 0;
    this.normalMesh.instanceMatrix.needsUpdate = true;
    this.bigMesh.instanceMatrix.needsUpdate = true;
  }

  /** Убирает зомби i, переставляя на его место последнего активного. */
  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.hp[i] = this.hp[last]!;
      this.attackTimer[i] = this.attackTimer[last]!;
      this.stopAt[i] = this.stopAt[last]!;
      this.isBig[i] = this.isBig[last]!;
      this.hpBarLeft[i] = this.hpBarLeft[last]!;
    }

    this.count--;
  }

  /** Состояние зомби — для отладки и проверок. */
  debugSnapshot(): Array<{
    x: number;
    z: number;
    hp: number;
    stopAt: number;
    kind: ZombieKind;
    hpBarLeft: number;
  }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        x: this.posX[i]!,
        z: this.posZ[i]!,
        hp: this.hp[i]!,
        stopAt: this.stopAt[i]!,
        kind: (this.isBig[i] === 1 ? 'big' : 'normal') as ZombieKind,
        hpBarLeft: +this.hpBarLeft[i]!.toFixed(3),
      });
    }
    return out;
  }
}
