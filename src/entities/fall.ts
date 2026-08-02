import { Vector3 } from 'three';
import { CONFIG } from '../config';

/**
 * Поза падающего тела — общая для зомби, босса и героя: капсула у них разная,
 * а формула одна, и раньше она была переписана трижды.
 *
 * ОСЬ ПОВОРОТА — У ПОДОШВЫ, а не в центре капсулы: тело подсекает в ногах и
 * заваливается, а не проворачивается на месте. Подошва — центр нижней полусферы,
 * точка (x, radius, z): именно она катится по дороге, и при любом наклоне капсула
 * касается асфальта, а не тонет в нём. Матрица (и quaternion меша) вращает вокруг
 * СВОЕГО начала — центра капсулы, — поэтому перенос оси делается руками: подошва
 * стоит, а центр едет по дуге вокруг неё, и меняются все три координаты сразу.
 *
 * НАПРАВЛЕНИЕ — ЛЮБОЕ ИЗ 360°. Сторона падения задаётся азимутом yaw в плоскости
 * дороги (0 — на +X, π/2 — на +Z, к камере), поэтому валится тело не вокруг оси Z,
 * как раньше, а вокруг горизонтального перпендикуляра к этому направлению.
 * Единичная длина оси обязательна: makeRotationAxis и setFromAxisAngle
 * нормировку не делают.
 */
export class FallPose {
  /** Наклон от вертикали, радианы: 0 — стоит, π/2 — лежит. */
  angle = 0;
  /** Ось поворота. Заведена один раз: поза считается каждый кадр каждому телу. */
  readonly axis = new Vector3(0, 0, -1);
  /** Центр капсулы — то, что и нужно поставить мешу. */
  x = 0;
  y = 0;
  z = 0;

  /**
   * Считает позу по остатку таймера падения. (x, z) — неподвижная подошва, то
   * есть место, где тело стояло в момент смерти.
   *
   * Доля падения возводится в квадрат — это ускорение: тело подсекает, а не
   * опускает. При fallSeconds = 0 анимации нет, тело сразу лежит.
   */
  set(
    x: number,
    z: number,
    yaw: number,
    fallLeft: number,
    capsule: { radius: number; length: number },
  ): this {
    const fallSeconds = CONFIG.deathAnim.fallSeconds;
    const done = fallSeconds > 0 ? 1 - Math.max(fallLeft, 0) / fallSeconds : 1;

    this.angle = (Math.PI / 2) * done * done;

    const dirX = Math.cos(yaw);
    const dirZ = Math.sin(yaw);
    this.axis.set(dirZ, 0, -dirX);

    const half = capsule.length / 2;
    const lean = half * Math.sin(this.angle);
    this.x = x + dirX * lean;
    this.y = capsule.radius + half * Math.cos(this.angle);
    this.z = z + dirZ * lean;

    return this;
  }

  /** Наклон в градусах — для отладочных снимков. */
  get tiltDegrees(): number {
    return (this.angle * 180) / Math.PI;
  }
}
