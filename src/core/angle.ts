/**
 * Углы и доворот к цели — общее у босса и у отряда: обе модели поворачиваются
 * по одной формуле (потолок скорости плюс ease через хранимую угловую скорость),
 * и держать её в двух копиях значило бы чинить рывки дважды.
 */

/**
 * Угол, приведённый к (−π, π]. Без этого доворот на 190° шёл бы «длинной
 * стороной», через 170° в обратную сторону.
 */
export function wrapAngle(angle: number): number {
  const full = Math.PI * 2;
  return ((((angle + Math.PI) % full) + full) % full) - Math.PI;
}

/** Значение, зажатое в ±limit. */
export function clampAbs(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/**
 * Шаг доворота к цели: возвращает новые угол и скорость.
 *
 * Скорость ХРАНИТСЯ вызывающим, и без этого ease-in не выходит: выставляя её по
 * остатку угла заново каждый кадр, модель срывалась бы с места на полной
 * скорости при каждой смене цели.
 *
 * Перелёта нет: тормозить модель начинает за maxSpeed × easeSeconds по углу, а
 * на само торможение с полной скорости уходит вдвое меньше.
 */
export function turnToward(
  yaw: number,
  yawSpeed: number,
  target: number,
  dt: number,
  maxDegreesPerSecond: number,
  easeSeconds: number,
): { yaw: number; yawSpeed: number } {
  const delta = wrapAngle(target - yaw);
  const maxSpeed = (maxDegreesPerSecond * Math.PI) / 180;

  let speed: number;
  if (easeSeconds > 0) {
    const desired = clampAbs(delta / easeSeconds, maxSpeed);
    // Ускорение выведено из потолка: за easeSeconds скорость успевает пройти
    // весь диапазон от нуля до максимума.
    speed = yawSpeed + clampAbs(desired - yawSpeed, (maxSpeed / easeSeconds) * dt);
  } else {
    // Ease выключен: поворот идёт сразу на потолке скорости.
    speed = clampAbs(delta / Math.max(dt, 1e-6), maxSpeed);
  }

  return { yaw: wrapAngle(yaw + speed * dt), yawSpeed: speed };
}
