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
  /** z, на котором предмет считается собранным. */
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
 * дороги, стягиваются к нему по x и собираются на его линии, — и различаются
 * только формой, цветом и тем, в какой счётчик уходит значение. Поэтому
 * механика живёт здесь, а наследники задают вид и числа.
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
  private readonly posZ: Float32Array;
  private readonly value: Float32Array;

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
    this.posZ = new Float32Array(shape.poolSize);
    this.value = new Float32Array(shape.poolSize);
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
    this.posZ[i] = z;
    this.value[i] = value;
    this.spawnedTotal++;
  }

  /**
   * Движение к отряду и сбор на его линии.
   * onCollect вызывается для каждого собранного предмета с его ценностью.
   */
  update(dt: number, squadX: number, onCollect: CollectHandler): void {
    const { worldSpeed } = CONFIG.world;
    const { y, speedScale, magnetLerp, collectZ, spinPerSecond } = this.motion;
    // Предмет летит быстрее дороги: скорость мира, умноженная на speedScale.
    //
    // Скорость берётся НОМИНАЛЬНАЯ (конфиг), а не текущая скорость забега, и это
    // единственное исключение среди всего, что движется к +Z. Предмет не едет с
    // дорогой — его тянет к отряду, а дорога тут только мерка скорости. На
    // остановленном мире (боссфайт) кристалл с расстрелянной бочки иначе повис бы
    // в воздухе до конца боя, и это читалось бы как поломка, а не как остановка.
    const step = worldSpeed * speedScale * dt;

    this.spin = (this.spin + spinPerSecond * dt * Math.PI * 2) % (Math.PI * 2);
    this.rotation.setFromAxisAngle(this.spinAxis, this.spin);

    for (let i = 0; i < this.count; ) {
      this.posZ[i]! += step;
      // Стягивание к отряду: доля остатка за фиксированный шаг, как у самого отряда.
      this.posX[i]! += (squadX - this.posX[i]!) * magnetLerp;

      if (this.posZ[i]! >= collectZ) {
        onCollect(this.value[i]!);
        this.collectedTotal++;
        this.recycle(i);
        // i не увеличиваем: в этот слот переехал последний активный.
        continue;
      }

      this.position.set(this.posX[i]!, y, this.posZ[i]!);
      this.matrix.compose(this.position, this.rotation, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Убирает всё с дороги и обнуляет статистику забега. */
  reset(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.spawnedTotal = 0;
    this.collectedTotal = 0;
  }

  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.value[i] = this.value[last]!;
    }

    this.count--;
  }

  /** Состояние пула — для отладки и проверок. */
  debugSnapshot(): Array<{ x: number; z: number; value: number }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({ x: +this.posX[i]!.toFixed(3), z: +this.posZ[i]!.toFixed(3), value: this.value[i]! });
    }
    return out;
  }
}
