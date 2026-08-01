import {
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import { bulletStyleFor, type WeaponId } from './weapons';

/**
 * Проверка попадания на ОТРЕЗКЕ полёта пули за один шаг.
 * Отрезок, а не точка: быстрая пуля иначе перескакивает цель между кадрами.
 *
 * radius — фактический радиус снаряда на этом шаге (у расширяющегося пламени он
 * растёт по пути), pierce — снаряд пробивающий, цель его не гасит и урон нужно
 * раздать всем задетым.
 *
 * Возвращает true, если пуля должна погаснуть. У пробивающего снаряда это НЕ
 * «попал»: он гаснет только о то, что физически держит огонь (стена ворот).
 */
export type BulletHitTest = (
  xFrom: number,
  zFrom: number,
  xTo: number,
  zTo: number,
  damage: number,
  radius: number,
  pierce: boolean,
) => boolean;

/** Ось поворота пули по направлению полёта. */
const UP = new Vector3(0, 1, 0);

/**
 * Пул пуль на одном InstancedMesh (ТЗ раздел 13 — «не создавать объекты каждый кадр»).
 *
 * Ни new, ни dispose в горячем цикле: инстансы и типизированные массивы
 * выделяются один раз при создании, дальше только перезаписываются матрицы.
 *
 * У каждой пули своё направление в плоскости XZ. По умолчанию это «вперёд»
 * (0, −1), но во время боссфайта отряд перенаправляет огонь на босса
 * (ТЗ раздел 10), и пуля летит по диагонали.
 *
 * Активные пули всегда лежат непрерывно в [0, activeCount): при гашении на
 * освободившийся слот переставляется последняя активная (swap-remove). Пули
 * одинаковые, порядок не важен, зато mesh.count можно держать равным числу пуль
 * в воздухе — GPU не обрабатывает все инстансы, когда летит две.
 */
export class BulletPool {
  private readonly mesh: InstancedMesh;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scaleVector = new Vector3();
  private readonly color = new Color();

  private readonly posX: Float32Array;
  private readonly posZ: Float32Array;
  /** Направление полёта, единичный вектор в плоскости XZ. */
  private readonly dirX: Float32Array;
  private readonly dirZ: Float32Array;
  /** Угол поворота вокруг Y — считается на выстреле, чтобы не звать atan2 по кадру. */
  private readonly angle: Float32Array;
  private readonly travelled: Float32Array;
  /** Урон пули: у разных стволов разный. */
  private readonly damage: Float32Array;
  /** Дальность конкретной пули: фиксируется на выстреле. */
  private readonly range: Float32Array;
  /** Вид снаряда, взятый у ствола на выстреле. */
  private readonly tintHex: Uint32Array;
  private readonly radiusScale: Float32Array;
  private readonly lengthScale: Float32Array;
  /** Во сколько раз снаряд шире к концу дальности (1 — не расширяется). */
  private readonly spread: Float32Array;
  /** Пробивающий снаряд: цель его не гасит. 1/0 вместо boolean — тот же пул. */
  private readonly pierce: Uint8Array;

  private count = 0;

  constructor(scene: Scene) {
    const { bullet } = CONFIG.weapons;

    // Ось цилиндра в three идёт по Y, а пуле надо по Z. Поворот запекаем в
    // геометрию один раз — дальше матрица содержит только перенос и рыскание.
    const geometry = new CylinderGeometry(bullet.radius, bullet.radius, bullet.length, 6);
    geometry.rotateX(Math.PI / 2);

    this.mesh = new InstancedMesh(
      geometry,
      // Basic, а не Standard: трассер должен быть ярким независимо от освещения.
      new MeshBasicMaterial({ color: bullet.color }),
      bullet.poolSize,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Инстансы движутся, bounding sphere меша не пересчитывается — без этого
    // сетка может целиком отсечься по фрустуму и пропасть.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);

    const size = bullet.poolSize;
    this.posX = new Float32Array(size);
    this.posZ = new Float32Array(size);
    this.dirX = new Float32Array(size);
    this.dirZ = new Float32Array(size);
    this.angle = new Float32Array(size);
    this.travelled = new Float32Array(size);
    this.damage = new Float32Array(size);
    this.range = new Float32Array(size);
    this.tintHex = new Uint32Array(size);
    this.radiusScale = new Float32Array(size);
    this.lengthScale = new Float32Array(size);
    this.spread = new Float32Array(size);
    this.pierce = new Uint8Array(size);

    // Первый setColorAt создаёт буфер instanceColor — делаем это сразу, чтобы
    // он не появлялся посреди горячего цикла.
    this.color.setHex(bullet.color);
    this.mesh.setColorAt(0, this.color);
  }

  /** Сколько пуль в воздухе. */
  get activeCount(): number {
    return this.count;
  }

  get capacity(): number {
    return this.posX.length;
  }

  /**
   * Выстрел от стрелка, стоящего в (x, z).
   *
   * aimX/aimZ — точка, куда целиться. Без неё пуля идёт строго вперёд; с ней
   * (боссфайт) направление берётся от дула к цели.
   *
   * Если пул исчерпан — выстрел молча теряется: терять пулю лучше, чем падать.
   */
  spawn(
    x: number,
    z: number,
    damage: number,
    range: number,
    weapon: WeaponId,
    aimX?: number,
    aimZ?: number,
  ): void {
    if (this.count >= this.capacity) return;

    const { muzzleOffsetZ, muzzleY } = CONFIG.weapons.bullet;
    const i = this.count++;

    // Вид снаряда фиксируется на выстреле: смена оружия у стрелка не должна
    // перекрашивать уже летящие пули.
    const style = bulletStyleFor(weapon);

    const muzzleX = x;
    const muzzleZ = z + muzzleOffsetZ;

    let dx = 0;
    let dz = -1;
    if (aimX !== undefined && aimZ !== undefined) {
      const toX = aimX - muzzleX;
      const toZ = aimZ - muzzleZ;
      const length = Math.hypot(toX, toZ);
      // Цель ровно в дуле — оставляем направление «вперёд», иначе делили бы на ноль.
      if (length > 1e-4) {
        dx = toX / length;
        dz = toZ / length;
      }
    }

    this.posX[i] = muzzleX;
    this.posZ[i] = muzzleZ;
    this.dirX[i] = dx;
    this.dirZ[i] = dz;
    this.angle[i] = Math.atan2(dx, dz);
    this.travelled[i] = 0;
    this.damage[i] = damage;
    this.range[i] = range;
    this.tintHex[i] = style.color;
    this.radiusScale[i] = style.radiusScale;
    this.lengthScale[i] = style.lengthScale;
    this.spread[i] = style.spread ?? 1;
    this.pierce[i] = style.pierce === true ? 1 : 0;

    // Матрицу и count выставляем сразу, а не ждём update(): иначе новая пуля не
    // рисуется до следующего шага, и вид зависит от порядка вызовов подсистем.
    this.writeInstance(i, muzzleY);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Двигает пули по их направлениям, отдаёт попадания и гасит те, что прошли
   * свою дальность. tryHit получает отрезок полёта за этот шаг.
   */
  update(dt: number, tryHit?: BulletHitTest): void {
    const { speed, muzzleY, radius: bulletRadius } = CONFIG.weapons.bullet;
    const step = speed * dt;

    for (let i = 0; i < this.count; ) {
      const xFrom = this.posX[i]!;
      const zFrom = this.posZ[i]!;
      this.posX[i]! += this.dirX[i]! * step;
      this.posZ[i]! += this.dirZ[i]! * step;
      this.travelled[i]! += step;

      // Ширина считается ПОСЛЕ шага — та же, что будет нарисована, чтобы
      // хитбокс пробивающего снаряда совпадал с картинкой.
      const width = this.widthScale(i);
      const piercing = this.pierce[i] === 1;

      if (
        tryHit !== undefined &&
        tryHit(
          xFrom,
          zFrom,
          this.posX[i]!,
          this.posZ[i]!,
          this.damage[i]!,
          piercing ? bulletRadius * width : bulletRadius,
          piercing,
        )
      ) {
        this.recycle(i);
        continue;
      }

      if (this.travelled[i]! >= this.range[i]!) {
        this.recycle(i);
        // i не увеличиваем: в этот слот только что переехала другая пуля.
        continue;
      }

      this.writeInstance(i, muzzleY, width);
      i++;
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Множитель ширины снаряда i на его текущем месте пути: от radiusScale у дула
   * до radiusScale × spread на конце дальности, линейно по пройденной доле.
   */
  private widthScale(i: number): number {
    const range = this.range[i]!;
    if (range <= 0) return this.radiusScale[i]!;

    const progress = Math.min(this.travelled[i]! / range, 1);
    return this.radiusScale[i]! * (1 + (this.spread[i]! - 1) * progress);
  }

  /** Матрица и цвет одного инстанса: перенос, рыскание по курсу, вид по стволу. */
  private writeInstance(i: number, muzzleY: number, width = this.widthScale(i)): void {
    this.position.set(this.posX[i]!, muzzleY, this.posZ[i]!);
    this.rotation.setFromAxisAngle(UP, this.angle[i]!);
    // Ось цилиндра запечена по Z, поэтому радиус — это X и Y, длина — Z.
    this.scaleVector.set(width, width, this.lengthScale[i]!);
    this.matrix.compose(this.position, this.rotation, this.scaleVector);
    this.mesh.setMatrixAt(i, this.matrix);

    this.color.setHex(this.tintHex[i]!);
    this.mesh.setColorAt(i, this.color);
  }

  /** Убирает все пули: новый забег начинается с чистого воздуха. */
  reset(): void {
    this.count = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Гасит пулю i, переставляя на её место последнюю активную. */
  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.posX[i] = this.posX[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.dirX[i] = this.dirX[last]!;
      this.dirZ[i] = this.dirZ[last]!;
      this.angle[i] = this.angle[last]!;
      this.travelled[i] = this.travelled[last]!;
      this.damage[i] = this.damage[last]!;
      this.range[i] = this.range[last]!;
      this.tintHex[i] = this.tintHex[last]!;
      this.radiusScale[i] = this.radiusScale[last]!;
      this.lengthScale[i] = this.lengthScale[last]!;
      this.spread[i] = this.spread[last]!;
      this.pierce[i] = this.pierce[last]!;
    }

    this.count--;
  }

  /** Позиции пуль — для отладки и проверок. */
  debugSnapshot(): Array<{
    x: number;
    z: number;
    dirX: number;
    dirZ: number;
    travelled: number;
    damage: number;
    width: number;
    pierce: boolean;
  }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        x: this.posX[i]!,
        z: this.posZ[i]!,
        dirX: +this.dirX[i]!.toFixed(3),
        dirZ: +this.dirZ[i]!.toFixed(3),
        travelled: this.travelled[i]!,
        damage: this.damage[i]!,
        width: +this.widthScale(i).toFixed(3),
        pierce: this.pierce[i] === 1,
      });
    }
    return out;
  }
}
