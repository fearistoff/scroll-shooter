import { Mesh, MeshBasicMaterial, SphereGeometry, type Scene } from 'three';
import { CONFIG } from '../config';
import type { RunState } from '../core/run';

/**
 * Вспышки взрывов: растущая полупрозрачная сфера в точке подрыва мины или
 * гранаты. Чистая картинка — урон уже нанесён мгновенно (damageInRadius),
 * сфера лишь показывает игроку накрытую зону и живёт explosionFx.seconds.
 *
 * Пул отдельных Mesh, как у мин: вспышек единицы даже в худшем случае
 * (весь пул мин рвётся одним кадром), InstancedMesh здесь не окупился бы.
 */
export class ExplosionPool {
  private readonly meshes: Mesh[] = [];

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  /** Прошедшее время жизни вспышки. */
  private readonly age: Float32Array;
  /** Конечный радиус сферы — у мины и гранаты он свой. */
  private readonly maxRadius: Float32Array;

  private count = 0;

  constructor(
    scene: Scene,
    private readonly run: RunState,
  ) {
    const { poolSize, color, opacity } = CONFIG.explosionFx;

    // Единичная сфера, размер задаётся через scale: одна геометрия и ОДИН
    // материал на весь пул — вспышки не отличаются ничем, кроме позиции и
    // радиуса. Basic, а не Standard: вспышка света не должна затеняться сценой.
    const geometry = new SphereGeometry(1, 16, 12);
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      // Мины рвутся все разом и сферы перекрываются: запись в депф-буфер
      // резала бы соседние вспышки по фронту первой отрисованной.
      depthWrite: false,
    });

    for (let i = 0; i < poolSize; i++) {
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.age = new Float32Array(poolSize);
    this.maxRadius = new Float32Array(poolSize);
  }

  get activeCount(): number {
    return this.count;
  }

  /**
   * Вспышка в точке (x, z), растущая до radius за explosionFx.seconds.
   * Переполнение пула логику не ломает: лишняя вспышка просто не показывается.
   */
  spawnAt(x: number, z: number, radius: number): void {
    if (this.count >= this.meshes.length) return;

    const i = this.count++;
    this.posX[i] = x;
    this.posZ[i] = z;
    this.age[i] = 0;
    this.maxRadius[i] = radius;
  }

  update(dt: number): void {
    const { seconds } = CONFIG.explosionFx;
    // Вспышку, как и мину, везёт дорога: за 50 мс это доли метра, но без
    // сдвига сфера отставала бы от точки, где лежал заряд.
    const step = this.run.worldSpeed * dt;

    for (let i = 0; i < this.count; ) {
      this.age[i]! += dt;
      if (this.age[i]! >= seconds) {
        this.recycle(i);
        continue;
      }

      this.posZ[i]! += step;

      // Центр на земле: над дорогой виден растущий купол, накрывающий цели.
      const scale = (this.maxRadius[i]! * this.age[i]!) / seconds;
      const mesh = this.meshes[i]!;
      mesh.visible = true;
      mesh.position.set(this.posX[i]!, 0, this.posZ[i]!);
      mesh.scale.setScalar(scale);

      i++;
    }
  }

  reset(): void {
    this.count = 0;
    for (const mesh of this.meshes) mesh.visible = false;
  }

  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.age[i] = this.age[last]!;
      this.maxRadius[i] = this.maxRadius[last]!;
    }

    this.count--;
    this.meshes[this.count]!.visible = false;
  }

  /** Состояние вспышек — для отладки и замерочных скриптов. */
  debugSnapshot(): Array<{ x: number; z: number; age: number; maxRadius: number }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        x: +this.posX[i]!.toFixed(3),
        z: +this.posZ[i]!.toFixed(3),
        age: +this.age[i]!.toFixed(4),
        maxRadius: this.maxRadius[i]!,
      });
    }
    return out;
  }
}
