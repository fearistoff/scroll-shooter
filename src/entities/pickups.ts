import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import { cubicBezierEase } from '../core/easing';

/** Что делать с собранным предметом. */
export type CollectHandler = (value: number) => void;

/**
 * Проекция в обе стороны, которая нужна пулу для полёта. Реализует её CameraSpace
 * (world/camera.ts), но объявлена она здесь, на стороне потребителя: ни камеры,
 * ни холста пул не видит и видеть не должен.
 */
export interface FlightSpace {
  /** Мировая точка → out = (пиксель x, пиксель y, расстояние до камеры). */
  project(x: number, y: number, z: number, out: Vector3): Vector3;
  /** Пиксель холста + расстояние от камеры → мировая точка. */
  unproject(screenX: number, screenY: number, distance: number, out: Vector3): Vector3;
}

/**
 * Числа движения, которые читаются КАЖДЫЙ КАДР, а не запоминаются при создании:
 * их крутят на живой игре через __config.
 */
export interface PickupMotion {
  /** Высота, на которой предмет появляется над точкой выпадения. */
  y: number;
  spinPerSecond: number;
  /**
   * Форма дуги: true — сначала вверх, потом вбок, false — наоборот. Кристаллы и
   * монеты летят в разные плашки, и разная форма пути помогает не путать потоки
   * там, где они идут одновременно.
   */
  flightVerticalFirst: boolean;
}

/** Что задаётся один раз при создании пула. */
export interface PickupShape {
  geometry: BufferGeometry;
  color: number;
  poolSize: number;
  /** Ось вращения. Своя у каждой формы: кристалл переливается, монета крутится. */
  spinAxis: Vector3;
}

/**
 * Общий пул подбираемых предметов: кристаллы EXP и монеты денег.
 *
 * Оба ведут себя ОДИНАКОВО — появляются в точке смерти и сразу улетают дугой в
 * свой счётчик в углу экрана, — и различаются только формой, цветом, стороной
 * дуги и тем, куда идёт значение. Поэтому механика живёт здесь, а наследники
 * задают вид и числа.
 *
 * ПУТЬ СЧИТАЕТСЯ В ЭКРАННЫХ КООРДИНАТАХ, а мировое положение получается обратной
 * проекцией (FlightSpace). Причина в том, что и цель, и форма дуги заданы
 * экраном: плашка счётчика живёт в DOM-оверлее, а «сначала вверх, потом влево» —
 * это про то, что видит игрок. В мире та же дуга выглядела бы по-разному с
 * разных концов дороги, потому что перспектива растягивает мировой x тем сильнее,
 * чем ближе точка к камере.
 *
 * Значение попадает в забег в КОНЦЕ полёта, а не при выпадении: счётчик должен
 * щёлкать в тот момент, когда в него что-то прилетело. Ничего при этом не
 * теряется — недолетевшее забирает flushPending на выходе из забега.
 *
 * Пул на одном InstancedMesh по образцу пуль: данные в Float32Array, гашение
 * через swap-remove, активные непрерывно в [0, count). За забег предметов сотни,
 * поэтому создавать их по одному нельзя.
 */
export abstract class PickupPool {
  private readonly mesh: InstancedMesh;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly spinAxis: Vector3;
  private readonly scale = new Vector3(1, 1, 1);
  /** Черновик проекции: заполняется project/unproject, живёт один вызов. */
  private readonly probe = new Vector3();

  // Мировое положение — только для матрицы инстанса; ведёт его экранный путь.
  private readonly posX: Float32Array;
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly value: Float32Array;

  /**
   * Полёт начат: точка старта спроецирована, дуга выбрана. Отдельным признаком,
   * потому что выпадение и первый шаг полёта разнесены во времени — spawn зовут
   * из воронок смерти, а проекция бывает только в update, где есть FlightSpace.
   */
  private readonly launched: Uint8Array;
  /** Доля пройденного времени полёта, 0…1. */
  private readonly flightT: Float32Array;
  /** Точка выпадения в пикселях холста и расстояние до неё от камеры. */
  private readonly startPx: Float32Array;
  private readonly startPy: Float32Array;
  private readonly startDistance: Float32Array;
  /** Смещение контрольной точки дуги, пиксели — своё у каждого предмета. */
  private readonly jitterX: Float32Array;
  private readonly jitterY: Float32Array;

  private count = 0;
  /** Общая фаза вращения: все предметы блестят синхронно, зато один кватернион. */
  private spin = 0;

  private spawnedTotal = 0;
  private collectedTotal = 0;

  protected constructor(scene: Scene, shape: PickupShape) {
    this.spinAxis = shape.spinAxis.clone().normalize();

    this.mesh = new InstancedMesh(
      shape.geometry,
      new MeshBasicMaterial({ color: shape.color }),
      shape.poolSize,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.posX = new Float32Array(shape.poolSize);
    this.posY = new Float32Array(shape.poolSize);
    this.posZ = new Float32Array(shape.poolSize);
    this.value = new Float32Array(shape.poolSize);
    this.launched = new Uint8Array(shape.poolSize);
    this.flightT = new Float32Array(shape.poolSize);
    this.startPx = new Float32Array(shape.poolSize);
    this.startPy = new Float32Array(shape.poolSize);
    this.startDistance = new Float32Array(shape.poolSize);
    this.jitterX = new Float32Array(shape.poolSize);
    this.jitterY = new Float32Array(shape.poolSize);
  }

  /**
   * Числа движения своего вида предметов. Геттер, а не поле: конфиг читается
   * каждый кадр, чтобы правки на живой игре действовали сразу.
   */
  protected abstract get motion(): PickupMotion;

  get activeCount(): number {
    return this.count;
  }

  get capacity(): number {
    return this.posX.length;
  }

  get spawned(): number {
    return this.spawnedTotal;
  }

  get collected(): number {
    return this.collectedTotal;
  }

  /** Роняет предмет в точке смерти зомби или разбитой бочки. */
  spawn(x: number, z: number, value: number): void {
    if (this.count >= this.capacity) return;

    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = this.motion.y;
    this.posZ[i] = z;
    this.value[i] = value;
    // Полёт начнётся на ближайшем шаге: точку старта нужно спроецировать, а
    // проекция есть только в update. Гасим признак — слот мог достаться от
    // предмета, который уже летел, и новый унаследовал бы его дугу.
    this.launched[i] = 0;
    this.flightT[i] = 0;
    this.spawnedTotal++;
  }

  /**
   * Полёт к счётчику. anchorX/anchorY — центр плашки в пикселях холста, его
   * меряет Hud. Передаётся каждый кадр, а не запоминается на старте: плашка
   * меняет ширину вместе с числом, и цель должна ехать за ней.
   *
   * onCollect вызывается в конце полёта с ценностью предмета.
   */
  update(
    dt: number,
    space: FlightSpace,
    anchorX: number,
    anchorY: number,
    onCollect: CollectHandler,
  ): void {
    const { spinPerSecond, flightVerticalFirst } = this.motion;
    const flight = CONFIG.pickupFlight;
    // Ноль допустим и означает мгновенное зачисление (полёт пропускается).
    const flightStep = flight.seconds > 0 ? dt / flight.seconds : 1;

    this.spin = (this.spin + spinPerSecond * dt * Math.PI * 2) % (Math.PI * 2);
    this.rotation.setFromAxisAngle(this.spinAxis, this.spin);

    for (let i = 0; i < this.count; ) {
      if (this.launched[i] === 0) this.launch(i, space);

      this.flightT[i]! += flightStep;

      if (this.flightT[i]! >= 1) {
        onCollect(this.value[i]!);
        this.collectedTotal++;
        this.recycle(i);
        // i не увеличиваем: в этот слот переехал последний активный.
        continue;
      }

      // Время → доля пути по заданной кривой скорости, и уже она ведёт и
      // положение, и размер: иначе предмет замедлялся бы, не уменьшаясь.
      const eased = cubicBezierEase(
        flight.ease.x1,
        flight.ease.y1,
        flight.ease.x2,
        flight.ease.y2,
        this.flightT[i]!,
      );

      /*
       * КВАДРАТИЧНАЯ КРИВАЯ БЕЗЬЕ В ПИКСЕЛЯХ: старт → контрольная точка → плашка.
       *
       * Контрольная точка и задаёт «угол» дуги. Взять её на пересечении вертикали
       * старта и горизонтали цели — и путь пойдёт сначала вверх, потом вбок;
       * взять на пересечении горизонтали старта и вертикали цели — наоборот.
       * Кривая срезает этот угол, поэтому получается дуга, а не ломаная.
       */
      const controlX = (flightVerticalFirst ? this.startPx[i]! : anchorX) + this.jitterX[i]!;
      const controlY = (flightVerticalFirst ? anchorY : this.startPy[i]!) + this.jitterY[i]!;

      const inv = 1 - eased;
      const wStart = inv * inv;
      const wControl = 2 * inv * eased;
      const wTarget = eased * eased;

      const screenX = wStart * this.startPx[i]! + wControl * controlX + wTarget * anchorX;
      const screenY = wStart * this.startPy[i]! + wControl * controlY + wTarget * anchorY;
      // Расстояние до камеры идёт от точки выпадения к цели по той же доле пути:
      // предмет с дальнего конца дороги приближается, а не прыгает вперёд.
      const distance =
        this.startDistance[i]! + (flight.cameraDistance - this.startDistance[i]!) * eased;

      space.unproject(screenX, screenY, distance, this.probe);
      this.posX[i] = this.probe.x;
      this.posY[i] = this.probe.y;
      this.posZ[i] = this.probe.z;

      this.write(i, 1 + (flight.endScale - 1) * eased);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Зачисляет всё, что не долетело до счётчика, и убирает его с экрана.
   * Зовётся на выходе из забега: выпавшее уже принадлежит игроку, и потерять его
   * из-за того, что забег кончился за полсекунды до зачисления, нельзя.
   *
   * Возвращает число зачисленных предметов — для замерочных скриптов.
   */
  flushPending(onCollect: CollectHandler): number {
    const flushed = this.count;

    for (let i = 0; i < this.count; i++) onCollect(this.value[i]!);

    this.collectedTotal += flushed;
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;

    return flushed;
  }

  /** Убирает всё с экрана и обнуляет статистику забега. */
  reset(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.spawnedTotal = 0;
    this.collectedTotal = 0;
  }

  /** Начало полёта: точка выпадения переводится в пиксели, выбирается дуга. */
  private launch(i: number, space: FlightSpace): void {
    const { arcJitterPx } = CONFIG.pickupFlight;

    space.project(this.posX[i]!, this.posY[i]!, this.posZ[i]!, this.probe);
    this.startPx[i] = this.probe.x;
    this.startPy[i] = this.probe.y;
    this.startDistance[i] = this.probe.z;

    // Дуга у каждого предмета чуть своя: без этого пара кристаллов, выпавших в
    // одной точке, шла бы к счётчику ровно одним следом.
    this.jitterX[i] = (Math.random() * 2 - 1) * arcJitterPx;
    this.jitterY[i] = (Math.random() * 2 - 1) * arcJitterPx;

    this.launched[i] = 1;
    this.flightT[i] = 0;
  }

  /** Кладёт текущее положение слота в матрицу инстанса. */
  private write(i: number, scale: number): void {
    this.position.set(this.posX[i]!, this.posY[i]!, this.posZ[i]!);
    this.scale.set(scale, scale, scale);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
  }

  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posY[i] = this.posY[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.value[i] = this.value[last]!;
      // Состояние полёта переезжает целиком: без него предмет, попавший в
      // освободившийся слот, потерял бы свою дугу и начал путь заново.
      this.launched[i] = this.launched[last]!;
      this.flightT[i] = this.flightT[last]!;
      this.startPx[i] = this.startPx[last]!;
      this.startPy[i] = this.startPy[last]!;
      this.startDistance[i] = this.startDistance[last]!;
      this.jitterX[i] = this.jitterX[last]!;
      this.jitterY[i] = this.jitterY[last]!;
    }

    this.count--;
  }

  /** Состояние пула — для отладки и проверок. */
  debugSnapshot(): Array<{ x: number; y: number; z: number; value: number; flightT: number }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        x: +this.posX[i]!.toFixed(3),
        y: +this.posY[i]!.toFixed(3),
        z: +this.posZ[i]!.toFixed(3),
        value: this.value[i]!,
        // −1 — выпал, но ещё не сделал первый шаг полёта.
        flightT: this.launched[i] === 1 ? +this.flightT[i]!.toFixed(3) : -1,
      });
    }
    return out;
  }
}
