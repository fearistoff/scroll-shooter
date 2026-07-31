import { CylinderGeometry, Mesh, MeshStandardMaterial, type Scene } from 'three';
import { CONFIG } from '../config';

/** Всё, что можно задеть взрывом (ТЗ: «по всем зомби и объектам в зоне»). */
export interface AreaDamageReceiver {
  /** Урон по кругу. Возвращает число задетых целей. */
  damageInRadius(x: number, z: number, radius: number, damage: number): number;
}

/** Зомби: по ним же проверяется подход, взводящий детонацию. */
export interface EnemyProbe extends AreaDamageReceiver {
  hasEnemyInRadius(x: number, z: number, radius: number): boolean;
}

/**
 * Противопехотные мины (ТЗ раздел 7).
 *
 * Бочка с миной расставляет их разом примерно на середине поля перед отрядом.
 * Через 1–2 секунды каждая активируется (меняет цвет), а как только к ЛЮБОЙ
 * активной мине подходит зомби — детонируют ВСЕ сразу, каждая своим кругом на
 * 20 hp. Урон фиксированный, поэтому крупный зомби взрыв переживёт.
 *
 * Мины едут вместе с миром, как бочки и ворота: по фикции отряд наступает на
 * брошенное вперёд, и статичная в экранных координатах мина выбивалась бы из
 * общего движения сцены.
 *
 * Пул — отдельные Mesh: мин единицы, зато каждой нужен свой цвет под состояние.
 */
export class MineField {
  private readonly meshes: Mesh[] = [];
  private readonly materials: MeshStandardMaterial[] = [];

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  /** Сколько осталось до активации; <= 0 — активна. */
  private readonly armIn: Float32Array;

  private readonly extraTargets: AreaDamageReceiver[] = [];

  private count = 0;

  private placedTotal = 0;
  private detonationsTotal = 0;
  private lastBlastHits = 0;

  constructor(
    scene: Scene,
    private readonly enemies: EnemyProbe,
  ) {
    const { size, poolSize, colors } = CONFIG.mine;

    // Ось цилиндра в three идёт по Y, поэтому шайба сразу лежит на земле.
    const geometry = new CylinderGeometry(size.radius, size.radius, size.height, 12);

    for (let i = 0; i < poolSize; i++) {
      const material = new MeshStandardMaterial({
        color: colors.idle,
        roughness: 0.7,
        metalness: 0.2,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(material);
    }

    this.posX = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.armIn = new Float32Array(poolSize);
  }

  /**
   * Добавляет цель, которую тоже накрывает взрыв (бочки).
   * Отдельным методом, а не через конструктор: бочкам нужен отряд, отряду —
   * мины, поэтому в конструкторе эта связь замкнулась бы в цикл.
   */
  addAreaTarget(target: AreaDamageReceiver): void {
    this.extraTargets.push(target);
  }

  get activeCount(): number {
    return this.count;
  }

  get capacity(): number {
    return this.meshes.length;
  }

  /** Сколько мин активны (взведены). */
  get armedCount(): number {
    let armed = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.armIn[i]! <= 0) armed++;
    }
    return armed;
  }

  get placed(): number {
    return this.placedTotal;
  }

  get detonations(): number {
    return this.detonationsTotal;
  }

  /** Сколько целей задел последний взрыв. */
  get lastHits(): number {
    return this.lastBlastHits;
  }

  /**
   * Бонус «мина» из бочки: расставляет count мин перед отрядом.
   * squadX — текущая позиция отряда, вокруг неё и раскладываем.
   */
  place(squadX: number, count = CONFIG.mine.count): void {
    const { placementZ, spreadX, armDelayRange } = CONFIG.mine;
    const roadHalf = CONFIG.world.roadWidth / 2;
    const [minDelay, maxDelay] = armDelayRange;

    for (let n = 0; n < count; n++) {
      if (this.count >= this.capacity) return;

      const i = this.count++;
      // Раскладываем поперёк дороги вокруг отряда, не вылезая за асфальт.
      const offset = count > 1 ? (n / (count - 1) - 0.5) * spreadX : 0;
      this.posX[i] = Math.min(Math.max(squadX + offset, -roadHalf), roadHalf);
      this.posZ[i] = placementZ;
      // Разброс задержки внутри 1–2 с из ТЗ: мины взводятся не строго синхронно.
      this.armIn[i] =
        (minDelay ?? 1) + Math.random() * ((maxDelay ?? 2) - (minDelay ?? 1));
      this.placedTotal++;
    }
  }

  /** Движение с миром, взведение, проверка подхода зомби. */
  update(dt: number): void {
    const { worldSpeed, despawnZ } = CONFIG.world;
    const { radius, size } = CONFIG.mine;
    const step = worldSpeed * dt;
    const y = size.height / 2;

    let triggered = false;

    for (let i = 0; i < this.count; ) {
      this.posZ[i]! += step;

      if (this.armIn[i]! > 0) {
        this.armIn[i]! -= dt;
      } else if (!triggered && this.enemies.hasEnemyInRadius(this.posX[i]!, this.posZ[i]!, radius)) {
        // Достаточно одной активной мины с зомби рядом: рвутся все разом.
        triggered = true;
      }

      if (this.posZ[i]! > despawnZ) {
        this.recycle(i);
        continue;
      }

      const mesh = this.meshes[i]!;
      mesh.visible = true;
      mesh.position.set(this.posX[i]!, y, this.posZ[i]!);
      this.materials[i]!.color.setHex(
        this.armIn[i]! <= 0 ? CONFIG.mine.colors.armed : CONFIG.mine.colors.idle,
      );

      i++;
    }

    for (let i = this.count; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
    }

    if (triggered) this.detonateAll();
  }

  /**
   * Детонация всех мин разом (ТЗ). Каждая бьёт своим кругом, поэтому цель в
   * перекрытии двух кругов получает урон дважды — так и должно быть: это два
   * заряда, а не один.
   */
  detonateAll(): void {
    const { radius, damage } = CONFIG.mine;
    let hits = 0;

    for (let i = 0; i < this.count; i++) {
      const x = this.posX[i]!;
      const z = this.posZ[i]!;

      hits += this.enemies.damageInRadius(x, z, radius, damage);
      for (const target of this.extraTargets) {
        hits += target.damageInRadius(x, z, radius, damage);
      }
    }

    this.detonationsTotal++;
    this.lastBlastHits = hits;

    // Все мины израсходованы.
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i]!.visible = false;
    this.count = 0;
  }

  /** Убирает мины без взрыва и обнуляет статистику забега. */
  reset(): void {
    this.count = 0;
    this.placedTotal = 0;
    this.detonationsTotal = 0;
    this.lastBlastHits = 0;
    for (const mesh of this.meshes) mesh.visible = false;
  }

  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.armIn[i] = this.armIn[last]!;
    }

    this.count--;
    this.meshes[this.count]!.visible = false;
  }

  /** Состояние мин — для отладки и проверок. */
  debugSnapshot(): Array<{ x: number; z: number; armIn: number; armed: boolean }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        x: +this.posX[i]!.toFixed(3),
        z: +this.posZ[i]!.toFixed(3),
        armIn: +this.armIn[i]!.toFixed(3),
        armed: this.armIn[i]! <= 0,
      });
    }
    return out;
  }
}
