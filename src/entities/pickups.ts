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
 * Числа движения, которые читаются КАЖДЫЙ КАДР, а не запоминаются при создании:
 * их крутят на живой игре через __config.
 */
export interface PickupMotion {
  /** Высота парения над дорогой. */
  y: number;
  /** Во сколько раз предмет летит быстрее дороги. */
  speedScale: number;
  /** Сближение с отрядом по x — доля остатка за шаг. */
  magnetLerp: number;
  /** z, на котором предмет считается подобранным и уходит к счётчику. */
  collectZ: number;
  spinPerSecond: number;
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
 * Оба ведут себя ОДИНАКОВО — выпадают в точке смерти, едут к отряду быстрее
 * дороги, стягиваются к нему по x, а с его линии уходят дугой в свой счётчик в
 * углу экрана, — и различаются только формой, цветом и тем, куда идёт значение.
 * Поэтому механика живёт здесь, а наследники задают вид и числа.
 *
 * ПУТЬ ИЗ ДВУХ ЧАСТЕЙ, и переключает их одно место — пересечение collectZ:
 *   дорога — предмет везёт к отряду поток (posX/posZ, скорость от worldSpeed);
 *   полёт  — предмет подобран и летит по кривой Безье в счётчик; на её конце
 *            зовётся onCollect, и только тогда значение попадает в забег.
 * Значение начисляется в конце полёта, а не при подборе, намеренно: счётчик
 * должен щёлкать в тот момент, когда в него что-то прилетело. Ничего при этом
 * не теряется — недолетевшее забирает flushPending на выходе из забега.
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

  private readonly posX: Float32Array;
  /** Высота. На дороге постоянная, в полёте её ведёт дуга. */
  private readonly posY: Float32Array;
  private readonly posZ: Float32Array;
  private readonly value: Float32Array;

  // Полёт к счётчику. Отдельным признаком, а не «flightT > 0»: у Float32Array
  // ноль — это и «не летит», и «только что стартовал».
  private readonly flying: Uint8Array;
  /** Доля пройденного времени полёта, 0…1. */
  private readonly flightT: Float32Array;
  private readonly startX: Float32Array;
  private readonly startY: Float32Array;
  private readonly startZ: Float32Array;
  /** Смещение контрольной точки дуги — своё у каждого предмета. */
  private readonly arcX: Float32Array;
  private readonly arcY: Float32Array;

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
    this.flying = new Uint8Array(shape.poolSize);
    this.flightT = new Float32Array(shape.poolSize);
    this.startX = new Float32Array(shape.poolSize);
    this.startY = new Float32Array(shape.poolSize);
    this.startZ = new Float32Array(shape.poolSize);
    this.arcX = new Float32Array(shape.poolSize);
    this.arcY = new Float32Array(shape.poolSize);
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

  /** Сколько предметов сейчас летит к счётчику — подобраны, но не зачислены. */
  get flyingCount(): number {
    let flying = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.flying[i] === 1) flying++;
    }
    return flying;
  }

  /** Роняет предмет в точке смерти зомби или разбитой бочки. */
  spawn(x: number, z: number, value: number): void {
    if (this.count >= this.capacity) return;

    const i = this.count++;
    this.posX[i] = x;
    this.posY[i] = this.motion.y;
    this.posZ[i] = z;
    this.value[i] = value;
    // Состояние полёта гасится здесь же: слот мог достаться от предмета, который
    // улетал к счётчику, и новый унаследовал бы его дугу. Точку старта и форму
    // дуги при этом обнулять не нужно — их читают только при flying = 1, а
    // выставляет beginFlight, и всегда все сразу.
    this.flying[i] = 0;
    this.flightT[i] = 0;
    this.spawnedTotal++;
  }

  /**
   * Движение к отряду, подбор на его линии и полёт в счётчик.
   *
   * target — мировая точка счётчика (её считает Game по плашке HUD, см.
   * screenToWorld). Передаётся каждый кадр, а не запоминается на старте полёта:
   * плашка меняет ширину вместе с числом, и цель должна ехать за ней.
   *
   * onCollect вызывается в конце полёта с ценностью предмета.
   */
  update(dt: number, squadX: number, target: Vector3, onCollect: CollectHandler): void {
    const { worldSpeed } = CONFIG.world;
    const { y, speedScale, magnetLerp, collectZ, spinPerSecond } = this.motion;
    const flight = CONFIG.pickupFlight;
    // Предмет летит быстрее дороги: скорость мира, умноженная на speedScale.
    //
    // Скорость берётся НОМИНАЛЬНАЯ (конфиг), а не текущая скорость забега, и это
    // единственное исключение среди всего, что движется к +Z. Предмет не едет с
    // дорогой — его тянет к отряду, а дорога тут только мерка скорости. На
    // остановленном мире (боссфайт) кристалл с расстрелянной бочки иначе повис бы
    // в воздухе до конца боя, и это читалось бы как поломка, а не как остановка.
    const step = worldSpeed * speedScale * dt;
    // Ноль допустим и означает мгновенное зачисление (полёт пропускается).
    const flightStep = flight.seconds > 0 ? dt / flight.seconds : 1;

    this.spin = (this.spin + spinPerSecond * dt * Math.PI * 2) % (Math.PI * 2);
    this.rotation.setFromAxisAngle(this.spinAxis, this.spin);

    for (let i = 0; i < this.count; ) {
      if (this.flying[i] === 1) {
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
        this.trace(i, eased, target);
        this.write(i, 1 + (flight.endScale - 1) * eased);
        i++;
        continue;
      }

      this.posZ[i]! += step;
      // Стягивание к отряду: доля остатка за фиксированный шаг, как у самого отряда.
      this.posX[i]! += (squadX - this.posX[i]!) * magnetLerp;
      this.posY[i] = y;

      // Подобран: дальше не едет, а летит к счётчику. Кадр он ещё отрисовывается
      // на линии отряда — с неё и начинается дуга.
      if (this.posZ[i]! >= collectZ) this.beginFlight(i);

      this.write(i, 1);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Зачисляет всё, что не долетело до счётчика, и убирает его с экрана.
   * Зовётся на выходе из забега: летящее уже подобрано игроком, и потерять его
   * из-за того, что забег кончился за 0.55 с до зачисления, нельзя.
   *
   * Едущее по дороге не трогает: оно не подобрано, и раньше пропадало так же.
   * Возвращает число зачисленных предметов — для замерочных скриптов.
   */
  flushPending(onCollect: CollectHandler): number {
    let flushed = 0;

    for (let i = 0; i < this.count; ) {
      if (this.flying[i] !== 1) {
        i++;
        continue;
      }

      onCollect(this.value[i]!);
      this.collectedTotal++;
      flushed++;
      this.recycle(i);
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;

    return flushed;
  }

  /** Убирает всё с дороги и обнуляет статистику забега. */
  reset(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.spawnedTotal = 0;
    this.collectedTotal = 0;
  }

  /** Начало полёта к счётчику: запоминается точка подбора и форма дуги. */
  private beginFlight(i: number): void {
    const { arcX, arcY } = CONFIG.pickupFlight;

    this.flying[i] = 1;
    this.flightT[i] = 0;
    this.startX[i] = this.posX[i]!;
    this.startY[i] = this.posY[i]!;
    this.startZ[i] = this.posZ[i]!;
    // «Произвольная дуга»: сторона и высота свои у каждого предмета, иначе
    // собранные подряд кристаллы уходили бы в угол одной линией.
    this.arcX[i] = (Math.random() * 2 - 1) * arcX;
    this.arcY[i] = arcY * (0.35 + Math.random() * 0.65);
  }

  /**
   * Точка на дуге по доле пути: квадратичная кривая Безье от места подбора к
   * счётчику. Контрольная точка — середина прямой, сдвинутая вбок и вверх на
   * случайные arcX/arcY, они и делают путь дугой, а не отрезком.
   */
  private trace(i: number, eased: number, target: Vector3): void {
    const inv = 1 - eased;
    const wStart = inv * inv;
    const wControl = 2 * inv * eased;
    const wTarget = eased * eased;

    const controlX = (this.startX[i]! + target.x) * 0.5 + this.arcX[i]!;
    const controlY = (this.startY[i]! + target.y) * 0.5 + this.arcY[i]!;
    const controlZ = (this.startZ[i]! + target.z) * 0.5;

    this.posX[i] = wStart * this.startX[i]! + wControl * controlX + wTarget * target.x;
    this.posY[i] = wStart * this.startY[i]! + wControl * controlY + wTarget * target.y;
    this.posZ[i] = wStart * this.startZ[i]! + wControl * controlZ + wTarget * target.z;
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
      // освободившийся слот, терял бы дугу и начинал путь заново.
      this.flying[i] = this.flying[last]!;
      this.flightT[i] = this.flightT[last]!;
      this.startX[i] = this.startX[last]!;
      this.startY[i] = this.startY[last]!;
      this.startZ[i] = this.startZ[last]!;
      this.arcX[i] = this.arcX[last]!;
      this.arcY[i] = this.arcY[last]!;
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
        // −1 — едет по дороге, 0…1 — доля пройденного полёта к счётчику.
        flightT: this.flying[i] === 1 ? +this.flightT[i]!.toFixed(3) : -1,
      });
    }
    return out;
  }
}
