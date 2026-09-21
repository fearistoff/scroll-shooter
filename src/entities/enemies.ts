import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Scene,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import { turnToward } from '../core/angle';
import { segmentHitsCircle, segmentPassesCircle } from '../core/collision';
import type { RunState, ZombieKind } from '../core/run';
import type { ExpSink } from './exp';
import { FallPose } from './fall';
import { makeCorpseColor, makeModelFlashColor } from './flash';
import type { MoneyPool } from './money';
import { buildFigureShadowGeometry, createOvalShadowMaterial } from './shadow';
import { buildZombieGeometry, figureHalfWidth } from './soldier';

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
   * Наносит урон ближайшему стрелку — без ограничения по расстоянию: кто именно
   * ближайший, считается по фактическому расстоянию до (fromX, fromZ), поэтому
   * первым получает передний ряд.
   *
   * Досягаемость проверяет ВЫЗЫВАЮЩИЙ: у зомби она своя у каждого вида (зона
   * поражения от роста, см. EnemyPool.reachOf), и отряд о ней не знает. Зомби
   * зовёт этот метод, только убедившись, что цель в зоне — по nearestShooter.
   *
   * Возвращает true, если удар кого-то достал; false означает «стрелков не
   * осталось».
   */
  damageNearestShooter(fromX: number, fromZ: number, amount: number): boolean;

  /**
   * Куда и как далеко до ближайшего стрелка от точки (fromX, fromZ).
   *
   * Нужен зомби трижды за кадр: доворот лицом к цели, боковая погоня за ней и
   * проверка, что она ещё в зоне поражения. Все три спрашивают ОДНО И ТО ЖЕ —
   * ближайшего стрелка, и три отдельных метода разошлись бы между собой:
   * зомби целился бы в одного, а бил другого.
   *
   * Пишет в переданный приёмник и возвращает true; при пустом отряде возвращает
   * false и приёмник не трогает. Приёмник, а не новый объект: метод зовётся на
   * каждого живого зомби каждый кадр, а зомби на дороге сотни.
   */
  nearestShooter(fromX: number, fromZ: number, out: ShooterHit): boolean;
}

/**
 * Приёмник для SquadTarget.nearestShooter: место ближайшего стрелка и квадрат
 * расстояния до него.
 *
 * Квадрат, а не расстояние: зомби сравнивает его с квадратом своей зоны
 * поражения, и корень в этой цепочке не нужен ни разу — а считался бы он на
 * каждого зомби каждый кадр.
 */
export interface ShooterHit {
  x: number;
  z: number;
  distanceSq: number;
}

/**
 * Поле неподвижных препятствий, которые зомби обходит вбок: бочки и части
 * ворот. «Неподвижных» — относительно дороги: их везёт мир, своих ног у них
 * нет, поэтому зомби нагоняет их (или они его — крупного зомби дорога везёт
 * быстрее, чем он идёт) и без обхода проходил бы насквозь.
 *
 * Интерфейс объявлен на стороне потребителя, как SquadTarget: реализуют его
 * BarrelField и GateField, но пул зомби о них не знает — Game подключает поля
 * через addObstacleField, тем же способом, что mines.addAreaTarget.
 *
 * След препятствия — прямоугольник в плоскости XZ (полуширины по осям):
 * бочка, секция стены и турникет им описываются точно, а круга здесь не
 * хватило бы — секция стены втрое шире своей толщины.
 */
export interface ObstacleField {
  forEachObstacle(
    visit: (x: number, z: number, halfX: number, halfZ: number) => void,
  ): void;
}

/**
 * Вместимость снимка препятствий на кадр. Бонус на экране один (bonusSlot),
 * но прямые spawn из замерочных скриптов слот не спрашивают, поэтому запас —
 * на полные пулы обоих полей: бочек 12 + частей ворот 16, с округлением вверх.
 * Лишние препятствия сверх вместимости молча не учитываются.
 */
const OBSTACLE_CAPACITY = 32;

/**
 * Код вида зомби в данных пула. Это ИНДЕКС: по нему выбираются меш, цвета и
 * скорость из массивов «по виду», поэтому значения обязаны быть 0..2 подряд.
 */
const KIND_NORMAL = 0;
const KIND_BIG = 1;
const KIND_FAST = 2;

/** Имя вида по коду — обратное отображение для debugSnapshot и воронок наград. */
const KIND_NAMES: readonly ZombieKind[] = ['normal', 'big', 'fast'];

function kindCode(kind: ZombieKind): number {
  return kind === 'big' ? KIND_BIG : kind === 'fast' ? KIND_FAST : KIND_NORMAL;
}

/** Параметры вида по коду. Единственное место, где код превращается в конфиг. */
function kindStats(code: number) {
  return code === KIND_BIG
    ? CONFIG.enemies.big
    : code === KIND_FAST
      ? CONFIG.enemies.fast
      : CONFIG.enemies.normal;
}

/** Полная высота капсулы — рост, а не length: у капсулы сверху и снизу полусферы. */
function capsuleHeight(capsule: { radius: number; length: number }): number {
  return capsule.length + 2 * capsule.radius;
}

/**
 * РОСТ МОДЕЛИ по коду вида, units (задано пользователем, 2026-08-13).
 *
 * Модель у всех видов ОДНА (soldier.ts, buildZombieGeometry), различаются только
 * равномерный масштаб и палитра, поэтому вид полностью задаётся ростом:
 *   обычный — полная высота его капсулы, 1.8;
 *   крупный — по отношению ВЫСОТ капсул (3.0 / 1.8 = ×1.667); это ровно полная
 *             высота его капсулы, поэтому она и стоит;
 *   быстрый — доля от роста обычного, enemies.fast.modelHeightScale (0.9, то
 *             есть рост 1.62): у него капсула той же высоты, что у обычного, и
 *             вывести рост из неё нельзя — число задано напрямую.
 * Масштаб во всех случаях равномерный по всем трём осям — так и требовалось.
 *
 * ЭТО НЕ БОЕВОЙ ГАБАРИТ. Попадания пуль, обход препятствий и линия остановки
 * по-прежнему считаются по kindStats().capsule, и у быстрого зомби хитбокс
 * поэтому шире силуэта сильнее, чем у остальных (общее правило
 * enemies.hitboxScale — хитбокс шире модели).
 */
function modelHeights(): number[] {
  const { normal, big, fast } = CONFIG.enemies;
  const normalHeight = capsuleHeight(normal.capsule);

  return [normalHeight, capsuleHeight(big.capsule), normalHeight * fast.modelHeightScale];
}

/**
 * Зомби всех видов (ТЗ раздел 9): обычные, крупные и быстрые.
 *
 * Все виды живут в ОДНОМ пуле: движение, остановка на линии, удары и попадания
 * у них одинаковые, различаются только HP, урон, габарит, скорость и палитра.
 * Разными остаются лишь InstancedMesh — по одному на вид, потому что фигурка у
 * них своего размера (modelHeights) и своего цвета (раскраска запечена в
 * геометрию, см. soldier.ts). Тени, наоборот, в одном меше на все виды: у
 * плоского овала вид задаётся масштабом инстанса.
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
  /** Меши по коду вида: [обычный, крупный, быстрый]. */
  private readonly meshes: readonly InstancedMesh[];
  /**
   * Овальные тени под фигурками (shadow.ts) — ОДИН меш на все виды и на тела:
   * геометрия у тени одна, вид задаётся масштабом инстанса, поэтому дробить её
   * по видам, как модели, не нужно.
   */
  private readonly shadows: InstancedMesh;
  /**
   * ВИДИМЫЙ габарит по коду вида — «капсула модели»: радиус равен ЗАМЕРЕННОЙ
   * полуширине фигурки (figureHalfWidth), длина добирает остаток роста, так что
   * length + 2 × radius = modelHeights()[код].
   *
   * По нему считаются посадка (центр в середине роста), высота полоски HP и поза
   * падения тела: игрок видит модель, а не боевую капсулу, и совпадают они только
   * по высоте. Радиус именно замеренный, потому что от него зависит, на какой
   * высоте лежит тело: возьми радиус боевой капсулы — и тело зависнет над
   * асфальтом на разницу (0.09 units у обычного зомби).
   */
  private readonly modelCapsules: ReadonlyArray<{ radius: number; length: number }>;
  private readonly matrix = new Matrix4();
  /** Черновик масштаба для матрицы инстанса: один на пул, в цикле не мусорим. */
  private readonly instanceScaleVec = new Vector3();
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
  /** Код вида: KIND_NORMAL / KIND_BIG / KIND_FAST. */
  private readonly kindOf: Uint8Array;
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
   * Куда зомби смотрит сейчас, радианы. Отряду соответствует π, а НЕ ноль:
   * модель зомби собрана из модели бойца и смотрит туда же, к −Z
   * (buildZombieGeometry), а идут они навстречу — зомби из −Z к отряду в z = 0.
   * Поэтому «лицом к отряду» — это разворот на 180°, и с него зомби выходит
   * (см. spawn).
   *
   * ЗАМЕРЕНО по boundingBox геометрии: вытянутые руки зомби лежат в −Z
   * (min.z = −0.276 у обычного), спина — в +Z (max.z = 0.512).
   *
   * Доворачивается к цели в updateFacing. Живого поля хватает одного: тело
   * поворот не меняет, оно падает по fallYaw.
   */
  private readonly yaw: Float32Array;
  /** Угловая скорость разворота, рад/с. Хранится ради ease-in (см. turnToward). */
  private readonly yawSpeed: Float32Array;

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

  /**
   * Цвета для instanceColor — МНОЖИТЕЛИ поверх запечённой в модель раскраски, а
   * не собственные цвета: опознавательная пара «куртка + кожа» теперь живёт в
   * геометрии вида (CONFIG.enemies.<вид>.colors). Поэтому обычное состояние —
   * белый (тождество), вспышка — ярче единицы (makeModelFlashColor), тело —
   * тёмный множитель, гасящий фигурку целиком, как раньше гасил цвет капсулы.
   *
   * Один набор на все виды, не по коду вида: множитель от палитры не зависит.
   * Заведены один раз — в цикле отрисовки мусорить нельзя.
   */
  private readonly baseColor = new Color(0xffffff);
  private readonly flashColor = makeModelFlashColor();
  private readonly corpseColor = makeCorpseColor(0xffffff);
  /**
   * Множитель скорости подхода по коду вида (нормаль — 1, см.
   * enemies.bigSpeedScale / fastSpeedScale) и счётчик отрисованных инстансов
   * каждого меша. Оба заведены полями, чтобы update не создавал массивы за кадр.
   */
  private readonly speedScaleOf: Float32Array;
  private readonly drawn = new Int32Array(KIND_NAMES.length);
  /**
   * Множитель размера тени по коду вида — тот же, что у модели (рост вида делить
   * на рост обычного): геометрия овала собрана под обычного зомби.
   */
  private readonly shadowScaleOf: Float32Array;
  /** Сколько теней записано за кадр — живые и тела идут в один меш подряд. */
  private shadowsDrawn = 0;

  /** Поля препятствий, которые зомби обходит. Заполняет Game после создания. */
  private readonly obstacleFields: ObstacleField[] = [];
  /**
   * Снимок препятствий на текущий кадр: собирается один раз в начале update и
   * дальше читается в цикле живых. Прямой опрос полей на каждого зомби стоил бы
   * вызова колбэка на каждую пару «зомби × препятствие», а зомби на дороге сотни.
   * Массивы заведены один раз — в update мусорить нельзя.
   */
  private readonly obstacleX = new Float32Array(OBSTACLE_CAPACITY);
  private readonly obstacleZ = new Float32Array(OBSTACLE_CAPACITY);
  private readonly obstacleHalfX = new Float32Array(OBSTACLE_CAPACITY);
  private readonly obstacleHalfZ = new Float32Array(OBSTACLE_CAPACITY);
  private obstacleCount = 0;

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
  private fastSpawnedTotal = 0;

  constructor(
    scene: Scene,
    private readonly run: RunState,
    private readonly exp: ExpSink,
    private readonly money: MoneyPool,
  ) {
    const { normal, big, fast, poolSize, bigSpeedScale, fastSpeedScale } = CONFIG.enemies;

    // Порядок — строго по кодам видов: KIND_NORMAL, KIND_BIG, KIND_FAST.
    const heights = modelHeights();
    this.meshes = [
      EnemyPool.createMesh(scene, heights[KIND_NORMAL]!, normal.colors, poolSize),
      EnemyPool.createMesh(scene, heights[KIND_BIG]!, big.colors, poolSize),
      EnemyPool.createMesh(scene, heights[KIND_FAST]!, fast.colors, poolSize),
    ];

    // Капсула модели: радиус — замер по фигурке, длина — остаток роста. Сумма
    // length + 2 × radius равна росту, поэтому центр в середине роста и подошвы на
    // дороге получаются сами, как у настоящей капсулы.
    const normalHeight = heights[KIND_NORMAL]!;
    this.modelCapsules = this.meshes.map((mesh, code) => {
      const radius = figureHalfWidth(mesh.geometry);
      return { radius, length: heights[code]! - 2 * radius };
    });

    // Тень — овал под фигурку обычного зомби; крупный и быстрый получают её тем
    // же равномерным масштабом, что и модель.
    this.shadows = new InstancedMesh(
      buildFigureShadowGeometry(normalHeight, normal.capsule.radius * 2),
      createOvalShadowMaterial(),
      poolSize,
    );
    this.shadows.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadows.frustumCulled = false;
    this.shadows.count = 0;
    scene.add(this.shadows);
    this.shadowScaleOf = new Float32Array(heights.map((height) => height / normalHeight));

    this.speedScaleOf = new Float32Array([1, bigSpeedScale, fastSpeedScale]);

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.hp = new Float32Array(poolSize);
    this.maxHp = new Float32Array(poolSize);
    this.damage = new Float32Array(poolSize);
    this.attackTimer = new Float32Array(poolSize);
    this.stopAt = new Float32Array(poolSize);
    this.kindOf = new Uint8Array(poolSize);
    this.hpBarLeft = new Float32Array(poolSize);
    this.flashLeft = new Float32Array(poolSize);
    this.recoverLeft = new Float32Array(poolSize);
    this.fallLeft = new Float32Array(poolSize);
    this.fallYaw = new Float32Array(poolSize);
    this.yaw = new Float32Array(poolSize);
    this.yawSpeed = new Float32Array(poolSize);

    this.slots = [
      this.posX,
      this.posZ,
      this.hp,
      this.maxHp,
      this.damage,
      this.attackTimer,
      this.stopAt,
      this.kindOf,
      this.hpBarLeft,
      this.flashLeft,
      this.recoverLeft,
      this.fallLeft,
      this.fallYaw,
      this.yaw,
      this.yawSpeed,
    ];
  }

  private static createMesh(
    scene: Scene,
    height: number,
    colors: { jacket: number; skin: number },
    poolSize: number,
  ): InstancedMesh {
    const mesh = new InstancedMesh(
      buildZombieGeometry(height, colors),
      // Материал БЕЛЫЙ и с вертексными цветами намеренно: раскраска фигурки
      // запечена в геометрию, а материал и instanceColor — множители поверх неё.
      // Поставь здесь зелёный — он перекрасил бы модель целиком, а вспышка (она
      // множитель ярче единицы) не смогла бы уйти от его оттенка.
      new MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.8,
        metalness: 0,
      }),
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

  get fastSpawned(): number {
    return this.fastSpawnedTotal;
  }

  /** Сколько крупных ЖИВЫХ зомби сейчас на поле. */
  get bigActiveCount(): number {
    let total = 0;
    for (let i = 0; i < this.aliveCount; i++) {
      if (this.kindOf[i] === KIND_BIG) total++;
    }
    return total;
  }

  /** Сколько быстрых ЖИВЫХ зомби сейчас на поле. */
  get fastActiveCount(): number {
    let total = 0;
    for (let i = 0; i < this.aliveCount; i++) {
      if (this.kindOf[i] === KIND_FAST) total++;
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
   * (money, bullets, barrels). У босса аргументов нет вовсе, и из
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
      if (kind !== 'normal' && kind !== 'big' && kind !== 'fast') {
        throw new TypeError(
          `EnemyPool.spawn: вид зомби — 'normal', 'big' или 'fast', получено ` +
            `${JSON.stringify(kind)}. Сигнатура — spawn(x, kind).`,
        );
      }
    }

    if (this.count >= this.capacity) return;

    const { stopZ, stopLineJitter, attackInterval, firstAttackDelay } = CONFIG.enemies;
    const code = kindCode(kind);
    const stats = kindStats(code);
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
    this.kindOf[i] = code;
    // Обязательно обнуляем: в этот слот мог попасть таймер убитого зомби, и
    // новый мигнул бы полоской, вспышкой и сжатием после чужого удара.
    this.hpBarLeft[i] = 0;
    this.flashLeft[i] = 0;
    this.recoverLeft[i] = 0;
    // Падение — из того же ряда: слот только что мог обслуживать тело, и без
    // обнуления новый зомби вышел бы на дорогу заваленным набок.
    this.fallLeft[i] = 0;
    this.fallYaw[i] = 0;
    /*
     * Разворот — туда же, и выходит зомби с НУЛЁМ, то есть уже лицом на отряд.
     *
     * Ноль — это лицо к +Z, к отряду: геометрия зомби собрана из модели бойца
     * (та смотрит к −Z) и развёрнута на 180° прямо в buildZombieGeometry, а не
     * здесь. Второй разворот на π поставил бы зомби спиной к отряду — с
     * вытянутыми руками в глубь дороги.
     */
    this.yaw[i] = 0;
    this.yawSpeed[i] = 0;

    this.spawnedTotal++;
    if (kind === 'big') this.bigSpawnedTotal++;
    if (kind === 'fast') this.fastSpawnedTotal++;
  }

  /**
   * Подключает поле препятствий для обхода. Зовётся из Game после создания
   * бочек и ворот — сами они создаются позже пула зомби, поэтому в конструктор
   * не попадают (см. порядок создания в CLAUDE.md).
   */
  addObstacleField(field: ObstacleField): void {
    this.obstacleFields.push(field);
  }

  /** Приёмник forEachObstacle. Одна ссылка на пул — колбэк зовётся каждый кадр. */
  private readonly collectObstacle = (
    x: number,
    z: number,
    halfX: number,
    halfZ: number,
  ): void => {
    if (this.obstacleCount >= OBSTACLE_CAPACITY) return;
    const i = this.obstacleCount++;
    this.obstacleX[i] = x;
    this.obstacleZ[i] = z;
    this.obstacleHalfX[i] = halfX;
    this.obstacleHalfZ[i] = halfZ;
  };

  /**
   * Снимок препятствий на кадр. Координаты — с ПРОШЛОГО шага полей: в Game
   * зомби обновляются раньше бочек и ворот. Расхождение — не больше шага мира
   * (0.1 units при 1/60), против зоны обхода в единицы units оно не значит ничего.
   */
  private collectObstacles(): void {
    this.obstacleCount = 0;
    for (const field of this.obstacleFields) {
      field.forEachObstacle(this.collectObstacle);
    }
  }

  /**
   * Обход препятствия зомби i: пока его путь перекрыт бочкой или частью ворот,
   * его отталкивает вбок со скоростью avoid.speed — он обтекает препятствие, а
   * не проходит насквозь.
   *
   * Зона по z СИММЕТРИЧНА (± lookAheadZ от габарита) намеренно: обычный и
   * быстрый зомби нагоняют препятствие сзади, а крупного дорога везёт
   * медленнее, чем препятствие, — оно наезжает на него само. Одно условие
   * покрывает оба направления сближения, и заодно стоящую у линии остановки
   * толпу расталкивает проезжающая сквозь неё бочка.
   *
   * Сторона — куда ближе (знак dx), но если с той стороны выйти некуда (край
   * дороги ближе зазора), толкает в другую: зомби у прижатой к обочине секции
   * стены уходит к проезду, а не утыкается в край. Одного препятствия за шаг
   * достаточно — бонус на экране один, перекрытые зоны почти не встречаются.
   */
  private avoidObstacles(i: number, radius: number, dt: number): void {
    const { lookAheadZ, margin, speed } = CONFIG.enemies.avoid;
    const roadLimit = CONFIG.world.roadWidth / 2 - radius;
    const x = this.posX[i]!;
    const z = this.posZ[i]!;

    for (let o = 0; o < this.obstacleCount; o++) {
      const reachZ = this.obstacleHalfZ[o]! + radius + lookAheadZ;
      const dz = z - this.obstacleZ[o]!;
      if (dz > reachZ || dz < -reachZ) continue;

      const clear = this.obstacleHalfX[o]! + radius + margin;
      const dx = x - this.obstacleX[o]!;
      if (dx >= clear || dx <= -clear) continue;

      let dir = dx >= 0 ? 1 : -1;
      if (Math.abs(this.obstacleX[o]! + dir * clear) > roadLimit) dir = -dir;

      this.posX[i] = Math.min(roadLimit, Math.max(-roadLimit, x + dir * speed * dt));
      return;
    }
  }

  /**
   * Радиус зоны поражения зомби i, units: рост вида × enemies.attackReach.
   *
   * От РОСТА, а не от радиуса капсулы (CONFIG.enemies.attackReach): виды
   * различаются ростом почти вдвое при близкой ширине, и «крупный достаёт
   * дальше» держится именно на росте. Рост берётся из капсулы МОДЕЛИ — это тот
   * габарит, который видит игрок.
   */
  private reachOf(code: number): number {
    const model = this.modelCapsules[code]!;
    return (model.length + 2 * model.radius) * CONFIG.enemies.attackReach;
  }

  /**
   * Приёмник ближайшего стрелка. Один на пул: цель опрашивается на каждого
   * живого зомби каждый кадр, и новый объект здесь — мусор сотнями за кадр.
   */
  private readonly shooterHit = { x: 0, z: 0, distanceSq: 0 };

  /**
   * Боковой ход к цели: зомби смещается по x, пока стрелок не окажется в зоне
   * поражения (CONFIG.enemies.pursuit).
   *
   * Идёт и на подходе, и у линии остановки (решение пользователя 2026-09-21):
   * без погони у линии зона поражения дала бы уводом отряда полный иммунитет —
   * толпа стояла бы столбами, промахиваясь мимо ушедшего вбок отряда.
   *
   * Только по x: по z зомби держит свою линию остановки, и подходить ближе ему
   * нельзя — иначе толпа въехала бы в строй.
   *
   * Мёртвая зона гасит дрожь у цели: шаг за кадр перелетает точную координату,
   * и без неё знак смещения менялся бы каждый кадр (см. pursuit.deadZoneX).
   */
  private pursueShooter(
    i: number,
    targetX: number,
    targetZ: number,
    reach: number,
    radius: number,
    dt: number,
  ): void {
    const { speed, deadZoneX } = CONFIG.enemies.pursuit;

    /*
     * ЦЕЛЬ ХОДА — КРАЙ ЗОНЫ, А НЕ КООРДИНАТА СТРЕЛКА. Зомби нужно ровно одно:
     * чтобы цель оказалась в зоне поражения. Дойдя до края зоны, он встаёт.
     *
     * Иначе вся толпа сходится в один x: каждый идёт к x ОДНОГО И ТОГО ЖЕ
     * ближайшего стрелка, и у линии остановки они складываются в колонну по
     * одному. ЗАМЕРЕНО на ходе «в точную координату»: шесть зомби у линии стояли
     * в пределах 0.16 units по x — вместо толпы получался столбик.
     *
     * Боковой охват считается из зоны: цель попадает в круг радиуса reach, когда
     * зомби подошёл по x на sqrt(reach² − dz²). У стоящих на разных линиях
     * остановки (stopLineJitter) dz разный, поэтому и охват разный — толпа
     * расходится по ширине сама, без отдельного разброса.
     *
     * ПОКА ЦЕЛЬ ДАЛЬШЕ ЗОНЫ ПО Z, боковой ход не нужен вовсе: на подходе (dz в
     * десятки units против зоны в единицы) круг до линии отряда не достаёт ни
     * при каком x, и «подойти по x» означало бы «встать ровно на координату
     * цели». Ровно так толпа и схлопывалась: ЗАМЕРЕНО — зомби со спавна в x = 4.5
     * приходил на x = 0.03 ещё на z = −33, за двадцать с лишним units до линии
     * остановки. Поэтому дальние идут прямо, а вбок забирают, подойдя.
     */
    const dz = targetZ - this.posZ[i]!;
    if (Math.abs(dz) >= reach) return;

    const lateral = Math.sqrt(reach * reach - dz * dz);

    const dx = targetX - this.posX[i]!;
    // Уже в зоне по x — стоим: подходить ближе незачем, цель и так достаётся.
    if (Math.abs(dx) <= lateral) return;

    // Идём только до края зоны, а не до самой цели.
    const need = Math.abs(dx) - lateral;
    if (need <= deadZoneX) return;

    const roadLimit = CONFIG.world.roadWidth / 2 - radius;
    const step = Math.min(speed * dt, need) * Math.sign(dx);
    this.posX[i] = Math.min(roadLimit, Math.max(-roadLimit, this.posX[i]! + step));
  }

  /**
   * Доворот зомби i лицом к точке (targetX, targetZ) — CONFIG.enemies.turn.
   *
   * Формула угла — боссовая, а не стрелковая: геометрия зомби развёрнута на 180°
   * ещё в buildZombieGeometry и при нулевом yaw смотрит к +Z, как модель босса.
   * Поэтому в atan2 идут остатки «цель минус зомби», без смены знака. Формула
   * стрелков (Squad.facingFor) здесь дала бы ровно обратное направление — их
   * модель смотрит к −Z.
   *
   * Сам поворот — общий turnToward (core/angle), как у босса и у отряда: скорость
   * хранится полем, иначе ease-in не выходит.
   */
  private updateFacing(i: number, targetX: number, targetZ: number, dt: number): void {
    const { maxDegreesPerSecond, easeSeconds } = CONFIG.enemies.turn;
    const target = Math.atan2(targetX - this.posX[i]!, targetZ - this.posZ[i]!);

    const turned = turnToward(
      this.yaw[i]!,
      this.yawSpeed[i]!,
      target,
      dt,
      maxDegreesPerSecond,
      easeSeconds,
    );
    this.yaw[i] = turned.yaw;
    this.yawSpeed[i] = turned.yawSpeed;
  }

  /** Поток сверху, движение к отряду, остановка на линии и удары. */
  update(dt: number, squad: SquadTarget): void {
    this.spawnStream(dt, squad);
    this.collectObstacles();

    const { extraSpeed, attackInterval, firstAttackDelay, attackAnim } = CONFIG.enemies;
    const { despawnZ } = CONFIG.world;
    // Скорость мира — текущая (run), а не номинальная: на боссфайте дорога стоит,
    // и зомби на ней шёл бы только своими ногами. Живых зомби в этот момент нет
    // (босс выходит на пустое поле), но правило одно на всех, кого везёт дорога.
    const worldSpeed = this.run.worldSpeed;
    // Зомби идут сами плюс их несёт наезжающий мир. Крупный подходит медленнее,
    // быстрый — быстрее: множитель по виду на всю скорость подхода, см.
    // enemies.bigSpeedScale / fastSpeedScale.
    const step = (worldSpeed + extraSpeed) * dt;

    this.drawn.fill(0);
    this.shadowsDrawn = 0;

    for (let i = 0; i < this.aliveCount; ) {
      const code = this.kindOf[i]!;
      const stats = kindStats(code);

      if (this.hpBarLeft[i]! > 0) this.hpBarLeft[i]! -= dt;
      if (this.flashLeft[i]! > 0) this.flashLeft[i]! -= dt;
      if (this.recoverLeft[i]! > 0) this.recoverLeft[i]! -= dt;

      const arrived = this.posZ[i]! >= this.stopAt[i]!;

      if (!arrived) {
        // Ещё идёт. Не перескакиваем линию остановки за шаг.
        this.posZ[i] = Math.min(
          this.posZ[i]! + step * this.speedScaleOf[code]!,
          this.stopAt[i]!,
        );
      }

      /*
       * ЦЕЛЬ. Один опрос на кадр, и от него зависят три вещи сразу: куда зомби
       * повёрнут, куда он смещается вбок и достаёт ли его удар. Опрашивать
       * порознь нельзя — перебор разошёлся бы, и зомби целился бы в одного
       * стрелка, а бил другого.
       *
       * Цель ищут и ИДУЩИЕ: доворот с погоней начинаются на подходе, поэтому
       * толпа приходит на отряд веером, а не стеной по всей ширине дороги.
       */
      const hasTarget = squad.nearestShooter(this.posX[i]!, this.posZ[i]!, this.shooterHit);

      if (hasTarget) {
        this.updateFacing(i, this.shooterHit.x, this.shooterHit.z, dt);
        this.pursueShooter(
          i,
          this.shooterHit.x,
          this.shooterHit.z,
          this.reachOf(code),
          stats.capsule.radius,
          dt,
        );
      }

      if (arrived) {
        /*
         * Дошёл: копит замах и бьёт ближайшего стрелка с периодом attackInterval —
         * но ТОЛЬКО пока цель в зоне поражения (reachOf, от роста вида).
         *
         * УДАР ПРЕРЫВАЕТСЯ, если стрелок из зоны ушёл (решение пользователя
         * 2026-09-21): таймер замаха откатывается к началу, и раздутая капсула
         * сдувается — зомби «не донёс» удар. Без отката зомби копил бы замах на
         * пустом месте и бил в тот же кадр, в который отряд вернулся бы в зону,
         * то есть увод отряда не давал бы ничего.
         *
         * Откат именно к firstAttackDelay, а не к нулю: вернувшийся в зону отряд
         * получает то же окно на реакцию, что и при первом подходе, — иначе
         * зомби, у которого цель мигнула из зоны и обратно, ударил бы почти сразу.
         */
        const reach = this.reachOf(code);
        const inReach = hasTarget && this.shooterHit.distanceSq <= reach * reach;

        if (!inReach) {
          this.attackTimer[i] = attackInterval - firstAttackDelay;
        } else {
          this.attackTimer[i]! += dt;
          if (this.attackTimer[i]! >= attackInterval) {
            this.attackTimer[i]! -= attackInterval;
            // Замах кончился ударом — дальше сжатие обратно.
            this.recoverLeft[i] = attackAnim.recoverSeconds;
            squad.damageNearestShooter(this.posX[i]!, this.posZ[i]!, this.damage[i]!);
          }
        }
      }

      // После шага по z: обход считается по позиции, в которой зомби окажется
      // на этом кадре. Толкает и дошедших — стоящую толпу раздвигает бочка.
      if (this.obstacleCount > 0) this.avoidObstacles(i, stats.capsule.radius, dt);

      const scale = this.instanceScale(i);

      // Страховка: за камеру ЖИВОЙ зомби уходить не должен, но если уйдёт — в пул
      // сразу, минуя область тел: падать ему уже негде, он за нижним краем экрана.
      if (this.posZ[i]! > despawnZ) {
        this.removeAlive(i);
        continue;
      }

      // Высота центра МОДЕЛИ умножается на тот же масштаб — иначе раздутый
      // зомби наполовину провалился бы под дорогу: модель масштабируется
      // относительно своего центра, а расти должна от подошвы.
      const model = this.modelCapsules[code]!;
      const y = (model.length / 2 + model.radius) * scale;
      // Поворот вокруг Y и равномерный масштаб замаха: makeRotationY задаёт
      // базис, scale домножает его на месте. Порядок важен — масштаб после
      // позиции сбросил бы её (так же собирается матрица бойца, Squad.layoutAllies).
      this.matrix.makeRotationY(this.yaw[i]!);
      this.matrix.scale(this.instanceScaleVec.setScalar(scale));
      this.matrix.setPosition(this.posX[i]!, y, this.posZ[i]!);
      // Цвет пишется рядом с матрицей и по тому же индексу отрисовки: у зомби
      // индекс в пуле и индекс в меше не совпадают (каждый вид рисуется своим
      // мешем), и разъехавшись, вспышка досталась бы чужому.
      const flashing = this.flashLeft[i]! > 0;
      const mesh = this.meshes[code]!;
      const slot = this.drawn[code]!;
      mesh.setMatrixAt(slot, this.matrix);
      mesh.setColorAt(slot, flashing ? this.flashColor : this.baseColor);
      this.drawn[code] = slot + 1;

      // Тень — после модели, тем же масштабом: пятно раздувается вместе с замахом.
      this.addShadow(this.posX[i]!, this.posZ[i]!, this.shadowScaleOf[code]! * scale);

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

      const code = this.kindOf[i]!;
      // Поза целиком — в FallPose: наклон вокруг подошвы в произвольную сторону
      // (там же разбор формулы). Тело валится в свою сторону из 360°, поэтому
      // уезжает от места смерти и по x, и по z. Габарит — модельный: тело должно
      // лежать на дороге тем, что видно, а не боевой капсулой.
      const pose = this.fallPose.set(
        this.posX[i]!,
        this.posZ[i]!,
        this.fallYaw[i]!,
        this.fallLeft[i]!,
        this.modelCapsules[code]!,
      );

      // Масштаба у тела нет: makeRotationAxis даёт единичный, и замах, застигнутый
      // смертью, обрывается.
      this.matrix.makeRotationAxis(pose.axis, pose.angle);
      this.matrix.setPosition(pose.x, pose.y, pose.z);

      const mesh = this.meshes[code]!;
      const slot = this.drawn[code]!;
      mesh.setMatrixAt(slot, this.matrix);
      mesh.setColorAt(slot, this.corpseColor);
      this.drawn[code] = slot + 1;

      // Тень у тела остаётся — лежащее тоже её отбрасывает — и стоит под ЦЕНТРОМ
      // тела (pose), а не под подошвами: заваливаясь, тело уезжает от места
      // смерти на половину своей длины, и пятно, оставленное на подошвах,
      // отрывалось бы от него. Своей позы у плоского овала при этом нет: он
      // всегда лежит вдоль солнца.
      this.addShadow(pose.x, pose.z, this.shadowScaleOf[code]!);

      i++;
    }

    for (let code = 0; code < this.meshes.length; code++) {
      const mesh = this.meshes[code]!;
      mesh.count = this.drawn[code]!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }

    this.shadows.count = this.shadowsDrawn;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  /**
   * Пишет овальную тень под фигурку: тот же равномерный масштаб, что у модели, но
   * плоско над дорогой. Сдвиг пятна вдоль солнца запечён в геометрию, поэтому
   * здесь только позиция подошв.
   *
   * Матрица общая с моделью и телом: setMatrixAt копирует, так что её можно
   * переиспользовать сразу после записи фигурки.
   */
  private addShadow(x: number, z: number, scale: number): void {
    this.matrix.makeScale(scale, scale, scale);
    this.matrix.setPosition(x, CONFIG.shadows.liftY, z);
    this.shadows.setMatrixAt(this.shadowsDrawn++, this.matrix);
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
      const reach = kindStats(this.kindOf[i]!).capsule.radius * hitboxScale + bulletRadius;

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
    const { offsetY, normalZombieScale } = CONFIG.ui.hpBar;

    // Только живые: у тела запас показывать нечем и не за чем следить.
    for (let i = 0; i < this.aliveCount; i++) {
      if (this.hpBarLeft[i]! <= 0) continue;

      const code = this.kindOf[i]!;
      // Макушка МОДЕЛИ, а не боевой капсулы: у быстрого зомби она ниже капсулы, и
      // полоска иначе висела бы в воздухе над ним.
      const model = this.modelCapsules[code]!;
      const top = model.length + model.radius * 2;
      // Полоска обычного и быстрого зомби мельче: их на дороге до 200, и полный
      // размер у каждого забивает кадр. У крупного размер базовый.
      visit(
        this.posX[i]!,
        top + offsetY,
        this.posZ[i]!,
        this.hp[i]! / this.maxHp[i]!,
        code === KIND_BIG ? 1 : normalZombieScale,
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
    const code = this.kindOf[i]!;
    // Сопротивление урону берётся по виду зомби и применяется здесь, в воронке, —
    // тогда его учитывают и пули, и взрывы мин, без правок в местах попадания.
    const resistance = kindStats(code).damageResistance;
    this.hp[i]! -= damage * resistance;
    // Единственная воронка урона по зомби (попадание пули и взрыв мины идут
    // через неё), поэтому таймеры полоски и вспышки ставятся здесь и только здесь.
    this.hpBarLeft[i] = CONFIG.ui.hpBar.showSeconds;
    this.flashLeft[i] = CONFIG.ui.damageFlash.seconds;
    if (this.hp[i]! > 0) return false;

    // Опыт начисляется за убийство; крупный и быстрый стоят дороже обычного
    // (ТЗ раздел 9, exp.perFastZombie). Точка смерти передаётся, хотя на экране
    // ничего не появляется, — см. ExpSink.award.
    const value =
      code === KIND_BIG
        ? CONFIG.exp.perBigZombie
        : code === KIND_FAST
          ? CONFIG.exp.perFastZombie
          : CONFIG.exp.perNormalZombie;
    this.exp.award(this.posX[i]!, this.posZ[i]!, value);

    // Деньги — там же, но не с каждого: бросок вероятности внутри воронки.
    // Зомби единственный их источник, поэтому вызов стоит только здесь и у босса.
    this.money.dropFrom(this.posX[i]!, this.posZ[i]!, KIND_NAMES[code]!);

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
    this.fastSpawnedTotal = 0;
    for (const mesh of this.meshes) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    // Тени гасятся вместе с фигурками, иначе на пустой дороге остались бы пятна.
    this.shadowsDrawn = 0;
    this.shadows.count = 0;
    this.shadows.instanceMatrix.needsUpdate = true;
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
    facingDegrees: number;
    reach: number;
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
        kind: KIND_NAMES[this.kindOf[i]!]!,
        hpBarLeft: +this.hpBarLeft[i]!.toFixed(3),
        attackTimer: +this.attackTimer[i]!.toFixed(3),
        recoverLeft: +this.recoverLeft[i]!.toFixed(3),
        // Фактический масштаб инстанса — по нему проверяется анимация атаки.
        scale: +this.instanceScale(i).toFixed(3),
        // Куда смотрит: 0 — вперёд на отряд, плюс — вправо. По нему проверяется
        // доворот, по reach — зона поражения.
        facingDegrees: +((this.yaw[i]! * 180) / Math.PI).toFixed(1),
        reach: +this.reachOf(this.kindOf[i]!).toFixed(3),
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
      const code = this.kindOf[i]!;
      const yaw = this.fallYaw[i]!;
      const pose = this.fallPose.set(
        this.posX[i]!,
        this.posZ[i]!,
        yaw,
        this.fallLeft[i]!,
        this.modelCapsules[code]!,
      );

      out.push({
        x: +this.posX[i]!.toFixed(3),
        z: +this.posZ[i]!.toFixed(3),
        kind: KIND_NAMES[code]!,
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
