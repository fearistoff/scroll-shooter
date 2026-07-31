import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';
import { CONFIG } from '../config';

/** Что делать с собранным кристаллом. */
export type CollectHandler = (value: number) => void;

/**
 * Кристаллы EXP (ТЗ раздел 9): падают с убитых зомби и разбитых бочек, едут к
 * отряду и попадают в счётчик забега.
 *
 * Пул на одном InstancedMesh по образцу пуль: данные в Float32Array, гашение
 * через swap-remove, активные непрерывно в [0, count). За забег кристаллов
 * сотни, поэтому создавать их по одному нельзя.
 *
 * Кристалл едет вместе с миром и одновременно стягивается по x к отряду — так
 * поток сходится к игроку и читается как «собирается», а не «проезжает мимо».
 * Собирается автоматически на линии отряда: подбирать вручную по ТЗ не нужно.
 */
export class CrystalPool {
  private readonly mesh: InstancedMesh;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly spinAxis = new Vector3(0.3, 1, 0.15).normalize();
  private readonly scale = new Vector3();

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  private readonly value: Float32Array;

  private count = 0;
  /** Общая фаза вращения: все кристаллы блестят синхронно, зато один кватернион. */
  private spin = 0;

  private spawnedTotal = 0;
  private collectedTotal = 0;

  constructor(scene: Scene) {
    const { crystalSize, crystalColor, poolSize } = CONFIG.exp;

    this.mesh = new InstancedMesh(
      // Октаэдр читается как кристалл и стоит дешевле любой огранки.
      new OctahedronGeometry(crystalSize),
      new MeshBasicMaterial({ color: crystalColor }),
      poolSize,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.value = new Float32Array(poolSize);
    this.scale.set(1, 1, 1);
  }

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

  /** Роняет кристалл в точке смерти зомби или разбитой бочки. */
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
   * onCollect вызывается для каждого собранного кристалла с его ценностью.
   */
  update(dt: number, squadX: number, onCollect: CollectHandler): void {
    const { worldSpeed } = CONFIG.world;
    const { y, magnetLerp, collectZ, spinPerSecond } = CONFIG.exp;
    const step = worldSpeed * dt;

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

  /** Убирает все кристаллы и обнуляет статистику забега. */
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

  /** Состояние кристаллов — для отладки и проверок. */
  debugSnapshot(): Array<{ x: number; z: number; value: number }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({ x: +this.posX[i]!.toFixed(3), z: +this.posZ[i]!.toFixed(3), value: this.value[i]! });
    }
    return out;
  }
}
