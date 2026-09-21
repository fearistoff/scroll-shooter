import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import type { RunState } from '../core/run';
import { buildBoxShadowGeometry, createFlatShadowMaterial } from '../entities/shadow';
import { type Biome, type DecorKind, STARTING_BIOME } from './biomes';
import {
  buildBushGeometry,
  buildCityWallGeometry,
  buildConiferGeometry,
  buildDeadTreeGeometry,
  buildGrassGeometry,
  buildRockGeometry,
  buildTreeGeometry,
} from './flora';

/**
 * Мир: дорога, земля, декор, растительность, свет, туман (ТЗ раздел 3).
 *
 * Отряд стоит на месте, а мир едет на него сверху вниз со скоростью run.worldSpeed
 * — именно это создаёт иллюзию движения вперёд, и именно поэтому остановленный мир
 * читается как остановившийся отряд (боссфайт). Полотно дороги и земля статичны
 * (однотонные, движение по ним не читается), а едет декор: центральная разметка,
 * придорожные столбики и растительность. Все наборы лежат в InstancedMesh и
 * раскладываются от одного накопленного scrollOffset с заворотом по модулю —
 * объекты не создаются и не удаляются, просто переставляются матрицы.
 *
 * ЛОКАЦИИ (biomes.ts). Геометрия коридора постоянна, меняются палитра и набор
 * декора. Меши при этом не пересоздаются: все три локации делят один набор
 * InstancedMesh, а вид переключается тонировкой (instanceColor) и нулевым
 * масштабом у неиспользуемых слотов.
 */
export class World {
  readonly group = new Group();

  /**
   * Высота земли по сторонам дороги, units: чуть ниже асфальта, чтобы на стыке не
   * было спора за z-буфер. Отсюда же считается высота теней столбиков — они лежат
   * на обочине, а не на дороге.
   */
  private static readonly shoulderY = -0.05;

  /** Накопленный сдвиг декора, units. Растёт на run.worldSpeed за секунду. */
  private offset = 0;

  private readonly markings: InstancedMesh;
  private readonly markingCount: number;
  private readonly markingSpan: number;

  private readonly roadside: InstancedMesh;
  /**
   * Тени столбиков — четырёхугольники на обочине (entities/shadow.ts). Отдельный
   * меш с тем же числом инстансов: раскладываются они вместе со столбиками, одной
   * матрицей на пару.
   */
  private readonly roadsideShadows: InstancedMesh;
  private readonly roadsideCount: number;
  private readonly roadsideSpan: number;

  private readonly roadMaterial: MeshStandardMaterial;
  private readonly shoulderMaterial: MeshStandardMaterial;
  private readonly markingMaterial: MeshBasicMaterial;
  private readonly roadsideMaterial: MeshStandardMaterial;
  /** Фон сцены — тот же объект Color, что и у тумана: переход красит оба разом. */
  private readonly background: Color;
  private readonly ambient: AmbientLight;
  private readonly dirLight: DirectionalLight;

  private readonly layers: DecorLayerMesh[] = [];

  /**
   * Локация, из которой мир перетекает, и та, в которую он приходит. Пока
   * переход не начат, обе равны текущей.
   */
  private fromBiome: Biome = STARTING_BIOME;
  private toBiome: Biome = STARTING_BIOME;
  /** Доля перехода, 0…1. 1 — мир полностью в toBiome. */
  private blend = 1;

  /** Дальняя граница декора: за краем тумана его всё равно не видно. */
  private readonly decorEndZ: number;

  private readonly matrix = new Matrix4();
  // Цвета переиспользуются: layoutDecor зовётся каждый кадр, аллокации там
  // недопустимы — по той же причине, что в flash.ts и barrels.ts.
  private readonly scratchColor = new Color();
  private readonly scratchFrom = new Color();
  private readonly scratchTo = new Color();
  // Вектор масштаба переиспользуется: layoutFlora идёт по сотням инстансов за кадр.
  private readonly scratchScale = new Vector3();

  constructor(
    scene: Scene,
    private readonly run: RunState,
  ) {
    const { world, camera, lights, biomes } = CONFIG;

    scene.background = new Color(STARTING_BIOME.fogColor);
    scene.fog = new Fog(STARTING_BIOME.fogColor, camera.fogNear, camera.fogFar);
    this.background = scene.background;

    this.decorEndZ = -(camera.fogFar + 8);

    // Полотно дороги тянется от точки за камерой далеко в туман, чтобы у
    // верхнего края кадра не было видно обрыва геометрии.
    const roadCenterZ = world.despawnZ - world.roadLength / 2;

    this.roadMaterial = new MeshStandardMaterial({
      color: STARTING_BIOME.road,
      roughness: 0.95,
      metalness: 0,
    });
    const road = new Mesh(new PlaneGeometry(world.roadWidth, world.roadLength), this.roadMaterial);
    road.rotation.x = -Math.PI / 2;
    road.position.z = roadCenterZ;
    this.group.add(road);

    // Земля по сторонам дороги — шире кадра, иначе у горизонта проступает фон.
    const shoulderGeometry = new PlaneGeometry(world.shoulderWidth, world.roadLength);
    this.shoulderMaterial = new MeshStandardMaterial({
      color: STARTING_BIOME.shoulder,
      roughness: 1,
      metalness: 0,
    });
    const shoulderX = world.roadWidth / 2 + world.shoulderWidth / 2;
    for (const side of [-1, 1]) {
      const shoulder = new Mesh(shoulderGeometry, this.shoulderMaterial);
      shoulder.rotation.x = -Math.PI / 2;
      shoulder.position.set(side * shoulderX, World.shoulderY, roadCenterZ);
      this.group.add(shoulder);
    }

    // --- Центральная разметка ---
    const marks = world.markings;
    this.markingCount = Math.ceil((world.despawnZ - this.decorEndZ) / marks.dashSpacing);
    this.markingSpan = this.markingCount * marks.dashSpacing;

    this.markingMaterial = new MeshBasicMaterial({ color: STARTING_BIOME.marking });
    this.markings = new InstancedMesh(
      new BoxGeometry(marks.dashWidth, 0.02, marks.dashLength),
      this.markingMaterial,
      this.markingCount,
    );
    this.prepareInstanced(this.markings);
    this.group.add(this.markings);

    // --- Придорожные столбики (по обеим сторонам) ---
    const side = world.roadside;
    this.roadsideCount = side.countPerSide;
    this.roadsideSpan = this.roadsideCount * side.spacingZ;

    this.roadsideMaterial = new MeshStandardMaterial({
      color: STARTING_BIOME.roadside,
      roughness: 0.9,
      metalness: 0,
    });
    this.roadside = new InstancedMesh(
      new BoxGeometry(side.size.x, side.size.y, side.size.z),
      this.roadsideMaterial,
      this.roadsideCount * 2,
    );
    this.prepareInstanced(this.roadside);
    this.group.add(this.roadside);

    this.roadsideShadows = new InstancedMesh(
      buildBoxShadowGeometry(side.size),
      createFlatShadowMaterial(),
      this.roadsideCount * 2,
    );
    this.prepareInstanced(this.roadsideShadows);
    this.group.add(this.roadsideShadows);

    // --- Растительность и застройка ---
    const span = world.despawnZ - this.decorEndZ;
    this.addLayer('grass', [buildGrassGeometry()], biomes.grassSpacingZ, span);
    this.addLayer('bush', [buildBushGeometry()], biomes.bushSpacingZ, span);
    this.addLayer('tree', [buildTreeGeometry()], biomes.treeSpacingZ, span);
    this.addLayer('conifer', [buildConiferGeometry()], biomes.treeSpacingZ, span);
    this.addLayer('deadTree', [buildDeadTreeGeometry()], biomes.treeSpacingZ, span);
    this.addLayer('rock', [buildRockGeometry()], biomes.bushSpacingZ, span);

    // Стена — несколько вариантов секции разной высоты в ОДНОМ слое: ровная
    // стена одной высоты читается как забор, а не как застройка. Шаг у всех
    // вариантов общий, поэтому секции по-прежнему стыкуются вплотную.
    const wall = biomes.cityWall;
    this.addLayer(
      'cityWall',
      wall.heights.map((height) =>
        buildCityWallGeometry(wall.width, height, wall.sectionLength),
      ),
      wall.sectionLength,
      span,
    );

    this.layoutDecor();

    this.ambient = new AmbientLight(lights.ambientColor, lights.ambientIntensity);
    this.group.add(this.ambient);

    this.dirLight = new DirectionalLight(lights.dirColor, lights.dirIntensity);
    this.dirLight.position.set(lights.dirPosition.x, lights.dirPosition.y, lights.dirPosition.z);
    // Цель — из конфига, а не числом здесь: по этой же паре считается наклон
    // плоских теней (entities/shadow.ts), и солнце у света и у теней одно.
    this.dirLight.target.position.set(lights.dirTarget.x, lights.dirTarget.y, lights.dirTarget.z);
    this.group.add(this.dirLight);
    this.group.add(this.dirLight.target);

    scene.add(this.group);
  }

  /** Накопленный сдвиг мира — для отладки и проверки скорости. */
  get scrollOffset(): number {
    return this.offset;
  }

  /** Локация, в которую мир переходит (или уже пришёл). */
  get biome(): Biome {
    return this.toBiome;
  }

  /**
   * Начать переход к новой локации. Зовётся на смене волны (Game.updateBossPhase).
   *
   * Переход НЕ РЕЗКИЙ и идёт в два хода одновременно: цвета земли, дороги,
   * тумана и света перетекают за CONFIG.biomes.transitionSeconds, а
   * растительность подменяется поштучно — в момент, когда очередной объект
   * заворачивается за дальний край (см. layoutFlora), то есть за туманом, где
   * его не видно. Прежняя локация уезжает к отряду, новая въезжает из тумана.
   *
   * Сроки у этих двух ходов СОГЛАСОВАНЫ ЧИСЛОМ В КОНФИГЕ: transitionSeconds
   * подобран под длину витка заворота, иначе палитра успевала смениться задолго
   * до растительности (см. комментарий к нему).
   *
   * Переход к той же локации, в которой мир уже находится, игнорируется: иначе
   * повторный вызов сбросил бы незаконченный переход на его же начало.
   */
  enterBiome(next: Biome): void {
    if (next === this.toBiome) return;
    // Стартуем не от fromBiome, а от фактической смеси: если прошлый переход не
    // успел закончиться, цвета не должны прыгнуть назад.
    this.fromBiome = this.blend >= 1 ? this.toBiome : this.mixedBiome();
    this.toBiome = next;
    this.blend = 0;
  }

  /**
   * Начало забега: мир возвращается в стартовую локацию мгновенно, без перехода.
   *
   * Перетекание здесь не нужно и мешало бы: между забегами игрок видит экран
   * результата и прокачки, а не дорогу, и плавная смена цветов доигрывалась бы
   * уже в новой вылазке. Слоты декора при этом получают стартовую локацию не
   * сразу, а по мере заворота (layoutFlora) — прежняя растительность уезжает за
   * спину так же, как при обычной смене волны.
   */
  reset(): void {
    this.fromBiome = STARTING_BIOME;
    this.toBiome = STARTING_BIOME;
    this.blend = 1;
    this.applyPalette();
  }

  /**
   * Двигает мир на игрока: декор едет вниз по экрану (в сторону +Z).
   *
   * Скорость берётся из забега, а не из конфига: на боссфайте она ноль, и декор
   * просто остаётся там, где стоял, — раскладка считается от того же offset.
   *
   * Палитра перехода считается по СЕКУНДАМ, а подмена декора — по ходу дороги
   * (заворот в layoutFlora). Разойтись эти часы могут только на остановленной
   * дороге, но переход и начинается ровно тогда, когда боссфайт кончился и
   * движение вернулось (Game.updateBossPhase), так что расхождения не возникает.
   */
  update(dt: number): void {
    this.offset += this.run.worldSpeed * dt;

    if (this.blend < 1) {
      const seconds = CONFIG.biomes.transitionSeconds;
      this.blend = seconds > 0 ? Math.min(1, this.blend + dt / seconds) : 1;
      this.applyPalette();
    }

    this.layoutDecor();
  }

  /** Состояние локаций — для замерочных скриптов. */
  debugSnapshot(): { from: string; to: string; blend: number; scrollOffset: number } {
    return {
      from: this.fromBiome.id,
      to: this.toBiome.id,
      blend: this.blend,
      scrollOffset: this.offset,
    };
  }

  private prepareInstanced(mesh: InstancedMesh): void {
    // Матрицы переписываются каждый кадр — сообщаем это драйверу.
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Инстансы движутся, а bounding sphere меша не пересчитывается: без этого
    // сетка может целиком отсечься по фрустуму и пропасть.
    mesh.frustumCulled = false;
  }

  /**
   * Заводит слой декора: меши на обе стороны дороги плюс запечённая раскладка.
   *
   * РАСКЛАДКА СЧИТАЕТСЯ ОДИН РАЗ, при сборке, и дальше только едет: случайные x,
   * сдвиг внутри шага, масштаб и оттенок — свои у каждого слота и постоянные.
   * Считай их заново каждый кадр — придорожный лес перетасовывался бы на глазах;
   * разыгрывай их при завороте — кусты прыгали бы с места на место при каждой
   * смене знака offset. Слот меняет свой облик только вместе с локацией.
   *
   * ВАРИАНТОВ ГЕОМЕТРИИ МОЖЕТ БЫТЬ НЕСКОЛЬКО — тогда слой держит по меша на
   * вариант, а слот занимает место ровно в одном из них (в остальных его инстанс
   * спрятан нулевой матрицей). Так стена получает секции разной высоты, оставаясь
   * ОДНИМ рядом с общим шагом: раздели её на три слоя со своим шагом каждый — и
   * секции наложились бы друг на друга, разорвав сплошную стену.
   */
  private addLayer(
    kind: DecorKind,
    variants: BufferGeometry[],
    spacingZ: number,
    span: number,
  ): void {
    // По слоту на шаг с каждой стороны, плюс один в запас: заворот по модулю
    // держит ровно столько мест, сколько укладывается в видимую глубину.
    const slotsPerSide = Math.ceil(span / spacingZ) + 1;
    const total = slotsPerSide * 2;

    const meshes = variants.map((geometry) => {
      const mesh = new InstancedMesh(
        geometry,
        // Материал белый: раскраска запечена в геометрию (baked.ts), а локация
        // красит поверх через instanceColor — с цветным материалом её оттенок
        // умножался бы на чужой.
        new MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.95,
          metalness: 0,
          vertexColors: true,
        }),
        total,
      );
      this.prepareInstanced(mesh);
      this.group.add(mesh);
      return mesh;
    });

    const layer: DecorLayerMesh = {
      kind,
      meshes,
      spacingZ,
      span: slotsPerSide * spacingZ,
      slotsPerSide,
      slots: [],
      // Заворот считается по индексу «витка»: пока объект не ушёл за дальний
      // край, его облик не меняется даже посреди перехода локации.
      lap: new Int32Array(total),
      biome: new Array(total).fill(this.toBiome),
    };

    const { decorFromX, decorToX, treeFromX, treeToX, jitterZ } = CONFIG.biomes;
    const wall = CONFIG.biomes.cityWall;
    const isWall = kind === 'cityWall';
    // У деревьев своя полоса, отодвинутая от дороги: их крона шире всего
    // остального и с общего ближнего края нависала бы над кромкой асфальта.
    const isTree = kind === 'tree' || kind === 'conifer' || kind === 'deadTree';
    const fromX = isTree ? treeFromX : decorFromX;
    const toX = isTree ? treeToX : decorToX;

    for (let i = 0; i < total; i++) {
      layer.slots.push({
        // Городская стена — исключение: она стоит ровно на своей линии, разброс
        // поперёк дороги разорвал бы её на уступы.
        offsetX: isWall ? wall.offsetX + wall.width / 2 : fromX + Math.random() * (toX - fromX),
        // Стене сдвиг вдоль дороги тоже не положен: между секциями появилась бы щель.
        jitterZ: isWall ? 0 : (Math.random() - 0.5) * jitterZ * spacingZ,
        // Разворот вокруг своей оси: одинаково ориентированные кусты выдают,
        // что это один и тот же меш. У стены он не читается (она вдоль дороги) и
        // при раскладке всё равно замещается разворотом по стороне.
        yaw: isWall ? 0 : Math.random() * Math.PI * 2,
        // Розыгрыши «занято / насколько крупный / насколько светлый / какой
        // вариант» хранятся как 0…1 и сравниваются с числами локации: тогда
        // смена локации меняет облик слота, не трогая его место на дороге.
        occupancy: Math.random(),
        scaleRoll: Math.random(),
        tintRoll: Math.random(),
        variant: Math.floor(Math.random() * variants.length),
      });
    }

    this.layers.push(layer);
  }

  /**
   * Локация как смесь текущего перехода — точка, от которой стартует следующий,
   * если прежний не успел закончиться.
   *
   * СМЕШИВАЮТСЯ ТОЛЬКО ЦВЕТА И СВЕТ; набор декора и опознавательные поля (id,
   * title) достаются от целевой локации как есть. Смешивать их незачем: облик
   * слота берётся из toBiome (см. layoutFlora), а смесь живёт только в fromBiome
   * и нужна ровно затем, чтобы цвета не прыгнули назад к началу прошлого перехода.
   * Побочный эффект — debugSnapshot().from после такого обрыва показывает
   * целевую локацию прерванного перехода, а не «смесь».
   */
  private mixedBiome(): Biome {
    const t = this.blend;
    const mix = (from: number, to: number): number =>
      this.scratchFrom.setHex(from).lerp(this.scratchTo.setHex(to), t).getHex();

    return {
      ...this.toBiome,
      fogColor: mix(this.fromBiome.fogColor, this.toBiome.fogColor),
      road: mix(this.fromBiome.road, this.toBiome.road),
      shoulder: mix(this.fromBiome.shoulder, this.toBiome.shoulder),
      roadside: mix(this.fromBiome.roadside, this.toBiome.roadside),
      marking: mix(this.fromBiome.marking, this.toBiome.marking),
      lightScale: this.fromBiome.lightScale + (this.toBiome.lightScale - this.fromBiome.lightScale) * t,
    };
  }

  /**
   * Красит землю, дорогу, туман и свет по текущей точке перехода.
   *
   * Зовётся только пока идёт переход: в остальное время цвета уже стоят на месте
   * и переписывать материалы каждый кадр незачем.
   */
  private applyPalette(): void {
    const t = this.blend;
    const lerp = (from: number, to: number, target: Color): Color =>
      target.setHex(from).lerp(this.scratchTo.setHex(to), t);

    lerp(this.fromBiome.road, this.toBiome.road, this.roadMaterial.color);
    lerp(this.fromBiome.shoulder, this.toBiome.shoulder, this.shoulderMaterial.color);
    lerp(this.fromBiome.marking, this.toBiome.marking, this.markingMaterial.color);
    lerp(this.fromBiome.roadside, this.toBiome.roadside, this.roadsideMaterial.color);
    // Фон и туман — один и тот же объект Color: горизонт и дальний край обязаны
    // совпадать, иначе на стыке проступает полоса.
    lerp(this.fromBiome.fogColor, this.toBiome.fogColor, this.background);

    const scale = this.fromBiome.lightScale + (this.toBiome.lightScale - this.fromBiome.lightScale) * t;
    this.ambient.intensity = CONFIG.lights.ambientIntensity * scale;
    this.dirLight.intensity = CONFIG.lights.dirIntensity * scale;
  }

  private layoutDecor(): void {
    this.layoutMarkings();
    this.layoutRoadside();
    for (const layer of this.layers) this.layoutFlora(layer);
  }

  /**
   * z для элемента декора с заворотом по модулю: уехавший за нижний край кадра
   * возвращается наверх, поэтому конечного набора инстансов хватает навсегда.
   */
  private wrapZ(index: number, spacing: number, span: number): number {
    const raw = index * spacing + this.offset;
    const wrapped = ((raw % span) + span) % span;
    return this.decorEndZ + wrapped;
  }

  private layoutMarkings(): void {
    const { dashSpacing } = CONFIG.world.markings;

    for (let i = 0; i < this.markingCount; i++) {
      const z = this.wrapZ(i, dashSpacing, this.markingSpan);
      this.matrix.makeTranslation(0, 0.01, z);
      this.markings.setMatrixAt(i, this.matrix);
    }

    this.markings.instanceMatrix.needsUpdate = true;
  }

  private layoutRoadside(): void {
    const { spacingZ, offsetX, size } = CONFIG.world.roadside;
    const y = size.y / 2;
    // Столбики стоят на обочине, а она ниже дороги — тень поднимается над НЕЙ, а
    // не над асфальтом, иначе висела бы в воздухе.
    const shadowY = World.shoulderY + CONFIG.shadows.liftY;

    let instance = 0;
    for (let i = 0; i < this.roadsideCount; i++) {
      const z = this.wrapZ(i, spacingZ, this.roadsideSpan);
      for (const side of [-1, 1]) {
        this.matrix.makeTranslation(side * offsetX, y, z);
        this.roadside.setMatrixAt(instance, this.matrix);
        // Тень — под основанием того же столбика: наклон и длина уже в геометрии.
        this.matrix.makeTranslation(side * offsetX, shadowY, z);
        this.roadsideShadows.setMatrixAt(instance++, this.matrix);
      }
    }

    this.roadside.instanceMatrix.needsUpdate = true;
    this.roadsideShadows.instanceMatrix.needsUpdate = true;
  }

  /**
   * Раскладка одного слоя декора.
   *
   * ОБЛИК СЛОТА ПЕРЕКЛЮЧАЕТСЯ НА ЗАВОРОТЕ, а не в момент смены локации: пока
   * объект едет по видимой части дороги, он остаётся в своей прежней локации, а
   * новую получает, только уйдя за дальний край (за туман). Иначе на глазах у
   * игрока кусты меняли бы цвет и размер, а деревья появлялись бы из воздуха.
   * Виток считается по тому же raw, что и wrapZ, — целочисленным делением.
   *
   * Слот занимает место ровно в одном меше слоя (в своём варианте геометрии), а
   * во всех остальных прячется нулевой матрицей: инстанс остаётся, но не рисуется.
   * Тем же нулевым масштабом гасится и незанятое место — так набор инстансов
   * постоянен, и смена локации не пересоздаёт меши.
   */
  private layoutFlora(layer: DecorLayerMesh): void {
    const { meshes, spacingZ, span, slotsPerSide, slots } = layer;
    const shoulderY = World.shoulderY;

    let instance = 0;
    for (let i = 0; i < slotsPerSide; i++) {
      const raw = i * spacingZ + this.offset;
      const lap = Math.floor(raw / span);
      const wrapped = raw - lap * span;
      const baseZ = this.decorEndZ + wrapped;

      for (const side of [-1, 1] as const) {
        const slot = slots[instance]!;

        // Новый виток — слот получает облик той локации, в которую мир идёт
        // СЕЙЧАС. Она же достаётся всем слотам при сборке, поэтому первый кадр
        // забега сразу выглядит как стартовая локация.
        if (layer.lap[instance] !== lap) {
          layer.lap[instance] = lap;
          layer.biome[instance] = this.toBiome;
        }

        const style = layer.biome[instance]!.decor[layer.kind];
        // Место занято, если розыгрыш попал в густоту локации.
        const occupied = slot.occupancy < style.density;

        for (let v = 0; v < meshes.length; v++) {
          const mesh = meshes[v]!;

          if (!occupied || v !== slot.variant) {
            this.matrix.makeScale(0, 0, 0);
            mesh.setMatrixAt(instance, this.matrix);
            continue;
          }

          const scale = style.scale * (1 + (slot.scaleRoll * 2 - 1) * style.scaleJitter);
          // Стена собрана проёмами в −x, то есть для ПРАВОЙ стороны (дорога от
          // неё в −x); левой она достаётся разворотом на 180°, а не зеркалом по
          // x: отрицательный масштаб вывернул бы намотку треугольников наизнанку,
          // и грани отбраковались бы задом наперёд.
          const yaw = layer.kind === 'cityWall' && side < 0 ? Math.PI : slot.yaw;

          this.matrix.makeRotationY(yaw);
          this.matrix.scale(this.scratchScale.set(scale, scale, scale));
          this.matrix.setPosition(side * slot.offsetX, shoulderY, baseZ + slot.jitterZ);
          mesh.setMatrixAt(instance, this.matrix);

          const tint = 1 + (slot.tintRoll * 2 - 1) * style.colorJitter;
          this.scratchColor.setHex(style.color).multiplyScalar(tint);
          mesh.setColorAt(instance, this.scratchColor);
        }

        instance++;
      }
    }

    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** Разыгранный при сборке облик одного места в ряду. */
interface DecorSlot {
  offsetX: number;
  jitterZ: number;
  yaw: number;
  /** Розыгрыши 0…1: сравниваются с числами локации при раскладке. */
  occupancy: number;
  scaleRoll: number;
  tintRoll: number;
  /** Номер варианта геометрии в слое: у стены им выбирается высота секции. */
  variant: number;
}

/** Слой одного вида декора: меш, шаг раскладки и состояние его слотов. */
interface DecorLayerMesh {
  kind: DecorKind;
  /** По мешу на вариант геометрии: слот занимает место ровно в одном из них. */
  meshes: InstancedMesh[];
  spacingZ: number;
  span: number;
  slotsPerSide: number;
  slots: DecorSlot[];
  /** Номер витка, на котором слот стоит сейчас: по его смене меняется локация слота. */
  lap: Int32Array;
  /** Локация, облик которой слот носит. */
  biome: Biome[];
}
