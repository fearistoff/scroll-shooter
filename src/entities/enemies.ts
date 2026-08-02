import {
  CapsuleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import { segmentHitsCircle, segmentPassesCircle } from '../core/collision';
import type { RunState, ZombieKind } from '../core/run';
import type { CrystalPool } from './crystals';
import { FallPose } from './fall';
import { makeCorpseColor, makeFlashColor } from './flash';
import type { MoneyPool } from './money';

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
   * Наносит урон ближайшему стрелку — без ограничения по расстоянию: нападающий
   * уже стоит на линии перед отрядом, и «ближайший» считается по фактическому
   * расстоянию до (fromX, fromZ), поэтому первым получает передний ряд.
   *
   * Возвращает true, если удар кого-то достал. False теперь означает только
   * «стрелков не осталось»: раньше так же сообщалось о промахе по досягаемости.
   */
  damageNearestShooter(fromX: number, fromZ: number, amount: number): boolean;
}

/**
 * Зомби обоих видов (ТЗ раздел 9): обычные и крупные.
 *
 * Оба вида живут в ОДНОМ пуле: движение, остановка на линии, удары и попадания
 * у них одинаковые, различаются только HP, урон, габарит и цвет. Разными
 * остаются лишь InstancedMesh — по одному на вид, потому что геометрия капсулы
 * у них разного размера.
 *
 * Данные в Float32Array, гашение через swap-remove — как у пуль и кристаллов.
 *
 * ПУЛ РАЗБИТ НА ДВЕ НЕПРЕРЫВНЫЕ ОБЛАСТИ, и это главное отличие от остальных пулов:
 *   [0, aliveCount)      — живые: идут, бьют, ловят пули;
 *   [aliveCount, count)  — ТЕЛА: падают набок (deathAnim), дальше просто едут с
 *                          миром до нижнего края экрана.
 * Тело — не отдельный пул, потому что слот у него тот же самый, и «зомби плюс
 * тела» ограничены одним числом (enemies.poolSize). Разделение на области, а не
 * флаг «мёртв» в общем массиве, выбрано затем, чтобы горячие циклы (попадания
 * пуль, взрывы, полоски HP) остались простыми `i < aliveCount` без проверки на
 * труп в каждой итерации.
 */
export class EnemyPool {
  private readonly normalMesh: InstancedMesh;
  private readonly bigMesh: InstancedMesh;
  private readonly matrix = new Matrix4();
  /** Поза падения. Одна на пул: тела считаются по очереди, мусорить нельзя. */
  private readonly fallPose = new FallPose();

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  private readonly hp: Float32Array;
  /**
   * С каким запасом зомби вышел: базовое HP вида × множитель волны. Хранится
   * поштучно, а не берётся из CONFIG, потому что с ростом волн на дороге
   * одновременно живут зомби разных волн, и доля для полоски у каждого своя.
   */
  private readonly maxHp: Float32Array;
  /**
   * Сколько снимает один удар ЭТОГО зомби: базовый damagePerHit вида × множитель
   * волны. Хранится поштучно по той же причине, что и maxHp: на дороге стоят
   * зомби разных волн, и сила удара у каждого своя.
   */
  private readonly damage: Float32Array;
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
  /** Остаток вспышки от урона (ui.damageFlash), тоже по игровому dt. */
  private readonly flashLeft: Float32Array;
  /**
   * Остаток сжатия после удара, секунды. Ставится в момент атаки, убывает по
   * игровому dt; пока > 0, капсула съезжает с peakScale обратно к 1.
   *
   * Замах отдельным полем НЕ хранится: он однозначно считается из attackTimer,
   * а вот сжатие — нет, потому что после удара таймер обнуляется.
   */
  private readonly recoverLeft: Float32Array;
  /**
   * Остаток падения тела, секунды. Ставится в момент смерти, убывает по игровому
   * dt; при <= 0 тело уже лежит. У живых всегда 0 — поле осмысленно только в
   * области тел.
   */
  private readonly fallLeft: Float32Array;
  /**
   * Азимут падения, радианы: куда в плоскости дороги заваливается тело. 0 — на
   * +X, π/2 — на +Z (к камере), то есть полный круг, а не две стороны.
   * Разыгрывается в момент смерти.
   */
  private readonly fallYaw: Float32Array;

  /**
   * Все массивы данных слота одним списком.
   *
   * Перестановки слотов (гибель, освобождение, спавн поверх тела) идут ЧЕРЕЗ ЭТОТ
   * СПИСОК, а не поимённым присваиванием, ровно по причине из CLAUDE.md: забытый
   * в переносе массив дарит новому объекту таймер предыдущего — так уже ловились
   * ложные полоски HP и вспышки. Мест переноса теперь три, и держать их
   * синхронными руками нереально. Добавили поле — добавьте его сюда.
   */
  private readonly slots: Array<Float32Array | Uint8Array | Int8Array>;

  /** Цвета для instanceColor. Заведены один раз: в цикле отрисовки нельзя мусорить. */
  private readonly normalColor = new Color(CONFIG.enemies.normal.color);
  private readonly bigColor = new Color(CONFIG.enemies.big.color);
  // Вспышка — светлый оттенок СВОЕГО цвета, поэтому у каждого вида свой.
  private readonly normalFlash = makeFlashColor(CONFIG.enemies.normal.color);
  private readonly bigFlash = makeFlashColor(CONFIG.enemies.big.color);
  // Тела — тёмный оттенок своего же цвета: мёртвые не должны читаться как толпа.
  private readonly normalCorpse = makeCorpseColor(CONFIG.enemies.normal.color);
  private readonly bigCorpse = makeCorpseColor(CONFIG.enemies.big.color);

  /** Занятых слотов всего: живые плюс тела. */
  private count = 0;
  /** Из них живых — они лежат в начале, в [0, aliveCount). */
  private aliveCount = 0;
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
    private readonly money: MoneyPool,
  ) {
    const { normal, big, poolSize } = CONFIG.enemies;

    this.normalMesh = EnemyPool.createMesh(scene, normal.capsule, normal.color, poolSize);
    this.bigMesh = EnemyPool.createMesh(scene, big.capsule, big.color, poolSize);

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.hp = new Float32Array(poolSize);
    this.maxHp = new Float32Array(poolSize);
    this.damage = new Float32Array(poolSize);
    this.attackTimer = new Float32Array(poolSize);
    this.stopAt = new Float32Array(poolSize);
    this.isBig = new Uint8Array(poolSize);
    this.hpBarLeft = new Float32Array(poolSize);
    this.flashLeft = new Float32Array(poolSize);
    this.recoverLeft = new Float32Array(poolSize);
    this.fallLeft = new Float32Array(poolSize);
    this.fallYaw = new Float32Array(poolSize);

    this.slots = [
      this.posX,
      this.posZ,
      this.hp,
      this.maxHp,
      this.damage,
      this.attackTimer,
      this.stopAt,
      this.isBig,
      this.hpBarLeft,
      this.flashLeft,
      this.recoverLeft,
      this.fallLeft,
      this.fallYaw,
    ];
  }

  private static createMesh(
    scene: Scene,
    capsule: { radius: number; length: number },
    _color: number,
    poolSize: number,
  ): InstancedMesh {
    const mesh = new InstancedMesh(
      new CapsuleGeometry(capsule.radius, capsule.length, 4, 10),
      // Материал БЕЛЫЙ намеренно: цвет каждого зомби задаётся через instanceColor,
      // который three умножает на цвет материала. Оставь здесь зелёный — вспышка
      // не смогла бы стать краснее его, умножение только гасит.
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 }),
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

  /**
   * ЖИВЫЕ зомби на дороге. Тела сюда не входят намеренно: по этому числу Game
   * решает, что волна зачищена и пора выпускать босса, — лежащие тела зачистке не
   * мешают. По той же причине его показывает счётчик «зомби» в отладочной строке.
   */
  get activeCount(): number {
    return this.aliveCount;
  }

  /** Тел на дороге — они доедут до нижнего края экрана и освободят слоты. */
  get corpseCount(): number {
    return this.count - this.aliveCount;
  }

  /** Занято слотов пула всего: живые плюс тела. Именно это упирается в capacity. */
  get usedSlots(): number {
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

  /** Сколько крупных ЖИВЫХ зомби сейчас на поле. */
  get bigActiveCount(): number {
    let total = 0;
    for (let i = 0; i < this.aliveCount; i++) {
      if (this.isBig[i] === 1) total++;
    }
    return total;
  }

  /**
   * Ставит зомби на линию спавна.
   *
   * Проверка на полный пул оставлена как страховка для прямых вызовов (тесты,
   * отладка). Поток через spawnStream до неё не доходит: он сам ждёт свободный
   * слот, потому что иначе списанная единица бюджета исчезала бы без зомби.
   *
   * Порядок аргументов — КООРДИНАТА ПЕРВОЙ, как у всех spawn в проекте
   * (crystals, money, bullets, barrels). У босса аргументов нет вовсе, и из
   * замерочного скрипта легко позвать `spawn('normal', -2.5)` по памяти.
   */
  spawn(x: number, kind: ZombieKind = 'normal'): void {
    /*
     * Ошибка в порядке аргументов ТИХАЯ, и в этом всё дело: строка, записанная в
     * Float32Array, превращается в NaN. Зомби при этом появляется, считается в
     * счётчиках и живёт полный цикл, но стоит в posX = NaN — все сравнения с ним
     * ложны, пули мимо, в отладочном снимке пусто. Скрипт молча меряет не то, а
     * замерочный прогон в этом проекте и есть проверка поведения.
     *
     * Поэтому в dev вызов падает сразу. В прод-сборке весь блок вырезается
     * (import.meta.env.DEV — константа на сборке), горячий путь спавна не
     * трогается, а изнутри spawnStream аргументы всегда корректны.
     */
    if (import.meta.env.DEV) {
      if (!Number.isFinite(x)) {
        throw new TypeError(
          `EnemyPool.spawn: первым аргументом идёт x (число), получено ${JSON.stringify(x)}. ` +
            `Сигнатура — spawn(x, kind).`,
        );
      }
      if (kind !== 'normal' && kind !== 'big') {
        throw new TypeError(
          `EnemyPool.spawn: вид зомби — 'normal' или 'big', получено ${JSON.stringify(kind)}. ` +
            `Сигнатура — spawn(x, kind).`,
        );
      }
    }

    if (this.count >= this.capacity) return;

    const { stopZ, stopLineJitter, attackInterval, firstAttackDelay } = CONFIG.enemies;
    const stats = kind === 'big' ? CONFIG.enemies.big : CONFIG.enemies.normal;
    // Живой встаёт в конец своей области, а не в конец пула: сразу за ним лежат
    // тела. Занявшее это место тело уезжает в первый свободный слот — обе области
    // остаются непрерывными.
    const i = this.aliveCount;
    if (this.count > this.aliveCount) this.swapSlots(i, this.count);
    this.aliveCount++;
    this.count++;

    this.posX[i] = x;
    this.posZ[i] = CONFIG.world.spawnZ;
    // Запас растёт от волны к волне (CONFIG.run.waveHpGrowth). Множитель берётся
    // на спавне и запоминается: у зомби, вышедших в разных волнах, разный максимум.
    this.hp[i] = stats.hp * this.run.hpMultiplier;
    this.maxHp[i] = this.hp[i]!;
    // Урон растёт своим множителем (CONFIG.run.waveDamageGrowth) и тоже
    // фиксируется на спавне.
    this.damage[i] = stats.damagePerHit * this.run.damageMultiplier;
    // Атака начинается с паузы: таймер копится только после того, как зомби дошёл
    // до линии остановки, поэтому первый удар прилетает через firstAttackDelay
    // ПОСЛЕ прибытия, а не в тот же кадр. Раньше здесь стоял attackInterval, то
    // есть таймер приходил уже полным и бил мгновенно.
    this.attackTimer[i] = attackInterval - firstAttackDelay;
    this.stopAt[i] = stopZ - Math.random() * stopLineJitter;
    this.isBig[i] = kind === 'big' ? 1 : 0;
    // Обязательно обнуляем: в этот слот мог попасть таймер убитого зомби, и
    // новый мигнул бы полоской, вспышкой и сжатием после чужого удара.
    this.hpBarLeft[i] = 0;
    this.flashLeft[i] = 0;
    this.recoverLeft[i] = 0;
    // Падение — из того же ряда: слот только что мог обслуживать тело, и без
    // обнуления новый зомби вышел бы на дорогу заваленным набок.
    this.fallLeft[i] = 0;
    this.fallYaw[i] = 0;

    this.spawnedTotal++;
    if (kind === 'big') this.bigSpawnedTotal++;
  }

  /** Поток сверху, движение к отряду, остановка на линии и удары. */
  update(dt: number, squad: SquadTarget): void {
    this.spawnStream(dt, squad);

    const { normal, big, extraSpeed, attackInterval, attackAnim } = CONFIG.enemies;
    const { despawnZ } = CONFIG.world;
    // Скорость мира — текущая (run), а не номинальная: на боссфайте дорога стоит,
    // и зомби на ней шёл бы только своими ногами. Живых зомби в этот момент нет
    // (босс выходит на пустое поле), но правило одно на всех, кого везёт дорога.
    const worldSpeed = this.run.worldSpeed;
    // Зомби идут сами плюс их несёт наезжающий мир.
    const step = (worldSpeed + extraSpeed) * dt;

    let normalDrawn = 0;
    let bigDrawn = 0;

    for (let i = 0; i < this.aliveCount; ) {
      const bigOne = this.isBig[i] === 1;
      const stats = bigOne ? big : normal;

      if (this.hpBarLeft[i]! > 0) this.hpBarLeft[i]! -= dt;
      if (this.flashLeft[i]! > 0) this.flashLeft[i]! -= dt;
      if (this.recoverLeft[i]! > 0) this.recoverLeft[i]! -= dt;

      const arrived = this.posZ[i]! >= this.stopAt[i]!;

      if (!arrived) {
        // Ещё идёт. Не перескакиваем линию остановки за шаг.
        this.posZ[i] = Math.min(this.posZ[i]! + step, this.stopAt[i]!);
      } else {
        // Дошёл: бьёт ближайшего стрелка с периодом attackInterval.
        this.attackTimer[i]! += dt;
        if (this.attackTimer[i]! >= attackInterval) {
          this.attackTimer[i]! -= attackInterval;
          // Замах кончился ударом — дальше сжатие обратно.
          this.recoverLeft[i] = attackAnim.recoverSeconds;
          squad.damageNearestShooter(this.posX[i]!, this.posZ[i]!, this.damage[i]!);
        }
      }

      const scale = this.instanceScale(i);

      // Страховка: за камеру ЖИВОЙ зомби уходить не должен, но если уйдёт — в пул
      // сразу, минуя область тел: падать ему уже негде, он за нижним краем экрана.
      if (this.posZ[i]! > despawnZ) {
        this.removeAlive(i);
        continue;
      }

      // Высота центра капсулы умножается на тот же масштаб — иначе раздутый
      // зомби наполовину провалился бы под дорогу: капсула масштабируется
      // относительно своего центра, а расти должна от подошвы.
      const y = (stats.capsule.length / 2 + stats.capsule.radius) * scale;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(this.posX[i]!, y, this.posZ[i]!);
      // Цвет пишется рядом с матрицей и по тому же индексу отрисовки: у зомби
      // индекс в пуле и индекс в меше не совпадают (обычные и крупные рисуются
      // разными мешами), и разъехавшись, вспышка досталась бы чужому.
      const flashing = this.flashLeft[i]! > 0;
      if (bigOne) {
        this.bigMesh.setMatrixAt(bigDrawn, this.matrix);
        this.bigMesh.setColorAt(bigDrawn, flashing ? this.bigFlash : this.bigColor);
        bigDrawn++;
      } else {
        this.normalMesh.setMatrixAt(normalDrawn, this.matrix);
        this.normalMesh.setColorAt(normalDrawn, flashing ? this.normalFlash : this.normalColor);
        normalDrawn++;
      }

      i++;
    }

    /*
     * ТЕЛА. Едут ТОЛЬКО с миром: мёртвый зомби своих ног больше не переставляет
     * (в этом и смысл «после смерти перестают двигаться»), но дорога под ним
     * продолжает наезжать на камеру — так тело и уходит за нижний край экрана,
     * где его забирает despawnZ. Стоять на месте оно не может: тогда труп остался
     * бы перед отрядом навсегда и слот не вернулся бы в пул.
     *
     * Ни ударов, ни таймеров полоски и вспышки здесь нет: тело только падает и
     * едет. Рисуется в те же InstancedMesh следом за живыми, счётчики инстансов
     * продолжаются — поэтому цикл стоит между живыми и записью mesh.count.
     */
    const carry = worldSpeed * dt;

    for (let i = this.aliveCount; i < this.count; ) {
      if (this.fallLeft[i]! > 0) this.fallLeft[i]! -= dt;
      this.posZ[i]! += carry;

      if (this.posZ[i]! > despawnZ) {
        this.removeCorpse(i);
        continue;
      }

      const bigOne = this.isBig[i] === 1;
      const capsule = (bigOne ? big : normal).capsule;
      // Поза целиком — в FallPose: наклон вокруг подошвы в произвольную сторону
      // (там же разбор формулы). Тело валится в свою сторону из 360°, поэтому
      // уезжает от места смерти и по x, и по z.
      const pose = this.fallPose.set(
        this.posX[i]!,
        this.posZ[i]!,
        this.fallYaw[i]!,
        this.fallLeft[i]!,
        capsule,
      );

      // Масштаба у тела нет: makeRotationAxis даёт единичный, и замах, застигнутый
      // смертью, обрывается.
      this.matrix.makeRotationAxis(pose.axis, pose.angle);
      this.matrix.setPosition(pose.x, pose.y, pose.z);

      if (bigOne) {
        this.bigMesh.setMatrixAt(bigDrawn, this.matrix);
        this.bigMesh.setColorAt(bigDrawn, this.bigCorpse);
        bigDrawn++;
      } else {
        this.normalMesh.setMatrixAt(normalDrawn, this.matrix);
        this.normalMesh.setColorAt(normalDrawn, this.normalCorpse);
        normalDrawn++;
      }

      i++;
    }

    this.normalMesh.count = normalDrawn;
    this.bigMesh.count = bigDrawn;
    this.normalMesh.instanceMatrix.needsUpdate = true;
    this.bigMesh.instanceMatrix.needsUpdate = true;
    if (this.normalMesh.instanceColor !== null) this.normalMesh.instanceColor.needsUpdate = true;
    if (this.bigMesh.instanceColor !== null) this.bigMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Попадание пули на отрезке её полёта за шаг (передаётся в BulletPool.update).
   * Отрезок произвольного направления: во время боссфайта пули идут по диагонали.
   * Габарит берётся по виду зомби.
   *
   * Пробивающий снаряд (огнемёт) перебирает весь пул до конца и наносит урон
   * КАЖДОМУ, кого пересёк, — и остаётся жив: возвращённый true для него значит
   * лишь «кого-то задело». Проверка при этом другая, segmentPassesCircle: снаряд
   * цель не гасит, висит в её габарите несколько кадров, и тест по расстоянию до
   * отрезка сработал бы каждый из них.
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
    // Хитбокс шире модели: попадания считаются по увеличенному радиусу, а капсула
    // рисуется прежнего размера.
    const hitboxScale = CONFIG.enemies.hitboxScale;
    let anyHit = false;

    // Только живые: тело пуля прошивает насквозь, добивать труп нечем и незачем.
    for (let i = 0; i < this.aliveCount; ) {
      const reach =
        (this.isBig[i] === 1 ? CONFIG.enemies.big : CONFIG.enemies.normal).capsule.radius *
          hitboxScale +
        bulletRadius;

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
      if (this.applyDamage(i, damage)) continue; // погиб — в слот переехал другой
      i++;
    }

    return anyHit;
  };

  /**
   * Есть ли живой зомби в круге — по этому взводится детонация мин.
   * Тела мину не взводят: подрываться на трупе она не должна.
   */
  hasEnemyInRadius(x: number, z: number, radius: number): boolean {
    const radiusSq = radius * radius;

    for (let i = 0; i < this.aliveCount; i++) {
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

    // Только живые: взрыв разбрасывал бы уже лежащие тела, а считать их в
    // «задетых» — врать статистике мин.
    for (let i = 0; i < this.aliveCount; ) {
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
  forEachHpBar(
    visit: (x: number, y: number, z: number, fraction: number, scale: number) => void,
  ): void {
    const { normal, big } = CONFIG.enemies;
    const { offsetY, normalZombieScale } = CONFIG.ui.hpBar;

    // Только живые: у тела запас показывать нечем и не за чем следить.
    for (let i = 0; i < this.aliveCount; i++) {
      if (this.hpBarLeft[i]! <= 0) continue;

      const bigOne = this.isBig[i] === 1;
      const stats = bigOne ? big : normal;
      const top = stats.capsule.length + stats.capsule.radius * 2;
      // Полоска обычного зомби мельче: их на дороге до 200, и полный размер у
      // каждого забивает кадр. У крупного размер базовый.
      visit(
        this.posX[i]!,
        top + offsetY,
        this.posZ[i]!,
        this.hp[i]! / this.maxHp[i]!,
        bigOne ? 1 : normalZombieScale,
      );
    }
  }

  /** Сколько полосок HP сейчас показано — для отладки и проверок. */
  get hpBarsVisible(): number {
    let total = 0;
    for (let i = 0; i < this.aliveCount; i++) {
      if (this.hpBarLeft[i]! > 0) total++;
    }
    return total;
  }

  /**
   * Масштаб капсулы зомби i — вся анимация атаки (CONFIG.enemies.attackAnim).
   *
   * Сжатие после удара проверяется ПЕРВЫМ и перебивает замах. Сразу после удара
   * attackTimer почти ноль, то есть замах и так дал бы 1, но порядок нужен на
   * случай кулдауна короче recoverSeconds: следующий замах там начинается,
   * когда сжатие ещё идёт, и без приоритета капсула дёргалась бы вверх-вниз.
   *
   * Замах считается только у ДОШЕДШИХ до линии остановки: у идущего attackTimer
   * стоит на стартовом значении (attackInterval − firstAttackDelay), и без этой
   * проверки при коротком firstAttackDelay зомби ехал бы к отряду уже раздутым.
   *
   * Только чтение: таймеры убывают в update, поэтому вызывать можно сколько угодно
   * раз за кадр — этим пользуется debugSnapshot.
   */
  private instanceScale(i: number): number {
    const { attackInterval, attackAnim } = CONFIG.enemies;
    const grow = attackAnim.peakScale - 1;

    if (this.recoverLeft[i]! > 0) {
      return 1 + grow * Math.min(this.recoverLeft[i]! / attackAnim.recoverSeconds, 1);
    }

    if (this.posZ[i]! < this.stopAt[i]!) return 1;

    const windupSeconds = attackInterval * attackAnim.windupPortion;
    if (windupSeconds <= 0) return 1;

    const windupLeft = this.attackTimer[i]! - (attackInterval - windupSeconds);
    if (windupLeft <= 0) return 1;

    return 1 + grow * Math.min(windupLeft / windupSeconds, 1);
  }

  /** Наносит урон зомби i. Возвращает true, если он погиб. */
  private applyDamage(i: number, damage: number): boolean {
    // Сопротивление урону берётся по виду зомби и применяется здесь, в воронке, —
    // тогда его учитывают и пули, и взрывы мин, без правок в местах попадания.
    const resistance = (this.isBig[i] === 1 ? CONFIG.enemies.big : CONFIG.enemies.normal)
      .damageResistance;
    this.hp[i]! -= damage * resistance;
    // Единственная воронка урона по зомби (попадание пули и взрыв мины идут
    // через неё), поэтому таймеры полоски и вспышки ставятся здесь и только здесь.
    this.hpBarLeft[i] = CONFIG.ui.hpBar.showSeconds;
    this.flashLeft[i] = CONFIG.ui.damageFlash.seconds;
    if (this.hp[i]! > 0) return false;

    // Кристалл падает там, где зомби погиб; крупный стоит дороже (ТЗ раздел 9).
    const big = this.isBig[i] === 1;
    const value = big ? CONFIG.exp.perBigZombie : CONFIG.exp.perNormalZombie;
    this.crystals.spawn(this.posX[i]!, this.posZ[i]!, value);

    // Деньги — там же, но не с каждого: бросок вероятности внутри воронки.
    // Зомби единственный их источник, поэтому вызов стоит только здесь и у босса.
    this.money.dropFrom(this.posX[i]!, this.posZ[i]!, big ? 'big' : 'normal');

    // Слот не освобождается: зомби становится телом и уезжает с дорогой.
    this.kill(i);
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
      /*
       * ПУЛ ПОЛОН — ЖДЁМ СЛОТ И БЮДЖЕТ НЕ ТРАТИМ.
       *
       * Порядок здесь критичен. Раньше сначала вызывался takeNextZombie(), а
       * spawn() уже внутри себя молча выходил, если мест нет, — и единица волны
       * пропадала, не став зомби. На высокой плотности (волна 5 даёт ~70 зомби в
       * секунду при пуле на 200) так испарялась большая часть волны: замер без
       * стрельбы показал, что из бюджета 300 списалось 300, а на дороге появилось
       * 200 — сотня исчезла. Полоса волны при этом честно показывала «осталось
       * 301» (она считает УБИТЫХ), зато allZombiesSpawned становился true, и на
       * зачищенном поле сразу выходил босс. Именно это и выглядело как «зомби
       * перестали появляться, и до половины полосы дело не дошло».
       *
       * Таймер пиннится на interval, а не копится: долгий полный пул иначе набрал
       * бы долг на минуты вперёд, и после разгрузки волна выплюнула бы его залпом.
       * С пиннингом освободившийся слот занимается на следующем же шаге.
       */
      if (this.count >= this.capacity) {
        this.spawnTimer = interval;
        break;
      }

      this.spawnTimer -= interval;

      // Вид и сам факт спавна решает забег: бюджет волны конечен.
      const kind = this.run.takeNextZombie();
      if (kind === null) return;

      const spread = (CONFIG.world.roadWidth / 2) * (lateralSpreadPercent / 100);
      this.spawn((Math.random() * 2 - 1) * spread, kind);
    }
  }

  /** Чистит поле и статистику: новый забег начинается с пустой дороги — и без тел. */
  reset(): void {
    this.count = 0;
    this.aliveCount = 0;
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

  /*
   * Ниже — ВСЯ работа со слотами пула. Обе области непрерывны, поэтому любое
   * изменение состава сводится к перестановкам, а не к сдвигам.
   */

  /** Меняет местами данные слотов a и b — по всему списку slots. */
  private swapSlots(a: number, b: number): void {
    if (a === b) return;

    for (const data of this.slots) {
      const kept = data[a]!;
      data[a] = data[b]!;
      data[b] = kept;
    }
  }

  /**
   * Убитый зомби i переходит в тела: его слот уезжает в начало области тел, на
   * освободившееся место в живых встаёт последний живой.
   */
  private kill(i: number): void {
    const last = this.aliveCount - 1;
    this.swapSlots(i, last);
    this.aliveCount--;

    // last === aliveCount после уменьшения, то есть это уже первое тело.
    this.fallLeft[last] = CONFIG.deathAnim.fallSeconds;
    // Сторона падения — любая из 360°, а не одна из двух: одинаковых поз в куче
    // тел не остаётся, при этом ложиться телу всё равно некуда, кроме плоскости
    // дороги, — вариативность бесплатная.
    this.fallYaw[last] = Math.random() * Math.PI * 2;
  }

  /**
   * Убирает ЖИВОГО зомби i совсем, без стадии тела.
   *
   * Две перестановки, а не одна: слот сначала уходит в конец живых, потом
   * меняется местами с последним телом — только так обе области остаются
   * непрерывными. Когда тел нет, вторая перестановка вырождается в пустую.
   */
  private removeAlive(i: number): void {
    const lastAlive = this.aliveCount - 1;
    this.swapSlots(i, lastAlive);
    this.swapSlots(lastAlive, this.count - 1);
    this.aliveCount--;
    this.count--;
  }

  /** Убирает тело i: оно скрылось за нижним краем экрана. */
  private removeCorpse(i: number): void {
    this.swapSlots(i, this.count - 1);
    this.count--;
  }

  /** Состояние ЖИВЫХ зомби — для отладки и проверок. Тела — в debugCorpses. */
  debugSnapshot(): Array<{
    x: number;
    z: number;
    hp: number;
    maxHp: number;
    damage: number;
    stopAt: number;
    kind: ZombieKind;
    hpBarLeft: number;
    attackTimer: number;
    recoverLeft: number;
    scale: number;
  }> {
    const out = [];
    for (let i = 0; i < this.aliveCount; i++) {
      out.push({
        x: this.posX[i]!,
        z: this.posZ[i]!,
        hp: this.hp[i]!,
        maxHp: this.maxHp[i]!,
        damage: this.damage[i]!,
        stopAt: this.stopAt[i]!,
        kind: (this.isBig[i] === 1 ? 'big' : 'normal') as ZombieKind,
        hpBarLeft: +this.hpBarLeft[i]!.toFixed(3),
        attackTimer: +this.attackTimer[i]!.toFixed(3),
        recoverLeft: +this.recoverLeft[i]!.toFixed(3),
        // Фактический масштаб инстанса — по нему проверяется анимация атаки.
        scale: +this.instanceScale(i).toFixed(3),
      });
    }
    return out;
  }

  /**
   * Состояние ТЕЛ — для отладки и проверок анимации смерти.
   *
   * x и z — НЕПОДВИЖНАЯ ПОДОШВА (где зомби стоял), bodyX/bodyY/bodyZ —
   * фактический центр капсулы, уехавший по дуге вокруг неё. tiltDegrees — наклон
   * (0 — стоит, 90 — лежит), yawDegrees — сторона падения (0 — на +X, 90 — на +Z).
   * Всё считается тем же FallPose, что и в отрисовке: иначе проверять пришлось бы
   * глазами.
   */
  debugCorpses(): Array<{
    x: number;
    z: number;
    kind: ZombieKind;
    fallLeft: number;
    tiltDegrees: number;
    yawDegrees: number;
    bodyX: number;
    bodyY: number;
    bodyZ: number;
  }> {
    const out = [];

    for (let i = this.aliveCount; i < this.count; i++) {
      const bigOne = this.isBig[i] === 1;
      const capsule = (bigOne ? CONFIG.enemies.big : CONFIG.enemies.normal).capsule;
      const yaw = this.fallYaw[i]!;
      const pose = this.fallPose.set(this.posX[i]!, this.posZ[i]!, yaw, this.fallLeft[i]!, capsule);

      out.push({
        x: +this.posX[i]!.toFixed(3),
        z: +this.posZ[i]!.toFixed(3),
        kind: (bigOne ? 'big' : 'normal') as ZombieKind,
        fallLeft: +this.fallLeft[i]!.toFixed(3),
        tiltDegrees: +pose.tiltDegrees.toFixed(1),
        yawDegrees: +((yaw * 180) / Math.PI).toFixed(1),
        bodyX: +pose.x.toFixed(3),
        bodyY: +pose.y.toFixed(3),
        bodyZ: +pose.z.toFixed(3),
      });
    }

    return out;
  }
}
