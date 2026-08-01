/**
 * Геометрия попаданий в плоскости XZ.
 *
 * До слоя 10 пули летели строго по −Z, и проверки обходились сравнением одной
 * координаты. С авто-фокусом огня на боссе (ТЗ раздел 10) пуля идёт по диагонали,
 * поэтому за шаг она проходит ОТРЕЗОК произвольного направления — и проверять
 * надо расстояние от цели до этого отрезка, а не до точки. Иначе быстрая пуля
 * перескакивает цель между кадрами.
 */

/** Квадрат расстояния от точки (cx, cz) до отрезка (x0, z0)–(x1, z1). */
export function distanceToSegmentSq(
  cx: number,
  cz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number {
  const abx = x1 - x0;
  const abz = z1 - z0;
  const lengthSq = abx * abx + abz * abz;

  // Нулевой отрезок (стоящая на месте пуля) — обычное расстояние до точки.
  let t = 0;
  if (lengthSq > 0) {
    t = ((cx - x0) * abx + (cz - z0) * abz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }

  const dx = cx - (x0 + t * abx);
  const dz = cz - (z0 + t * abz);
  return dx * dx + dz * dz;
}

/** Попадает ли отрезок в круг радиуса radius вокруг (cx, cz). */
export function segmentHitsCircle(
  cx: number,
  cz: number,
  radius: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  return distanceToSegmentSq(cx, cz, x0, z0, x1, z1) <= radius * radius;
}

/**
 * Прошёл ли отрезок ЧЕРЕЗ поперечную линию круга именно на этом шаге: центр
 * цели проецируется внутрь отрезка (доля пути в [0, 1)), а поперечное
 * расстояние не больше radius.
 *
 * Для ПРОБИВАЮЩЕГО снаряда (огнемёт), которого цель не гасит. Обычный тест
 * segmentHitsCircle там не годится: снаряд остаётся в габарите цели два-три
 * кадра подряд и наносил бы урон каждый из них. Здесь же условие выполняется
 * ровно на одном шаге — том, где снаряд миновал центр цели, — поэтому урон
 * достаётся один раз и без хранения списка уже задетых целей на каждый снаряд.
 *
 * Половина интервала открытая (t < 1, а не t <= 1) намеренно: конец отрезка
 * этого шага — начало следующего, и на закрытом интервале цель ровно на стыке
 * получила бы урон дважды.
 */
export function segmentPassesCircle(
  cx: number,
  cz: number,
  radius: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const abx = x1 - x0;
  const abz = z1 - z0;
  const lengthSq = abx * abx + abz * abz;

  // Стоящий снаряд ничего не пересекает: пересечение здесь — событие движения.
  if (lengthSq <= 0) return false;

  const t = ((cx - x0) * abx + (cz - z0) * abz) / lengthSq;
  if (t < 0 || t >= 1) return false;

  const dx = cx - (x0 + t * abx);
  const dz = cz - (z0 + t * abz);
  return dx * dx + dz * dz <= radius * radius;
}

/**
 * Пересекает ли отрезок плиту, стоящую поперёк дороги: полосу по z толщиной
 * thickness на глубине slabZ и шириной halfWidth по x вокруг centerX.
 *
 * Считается точка пересечения отрезка с плоскостью плиты — так работает и для
 * диагональной пули, в отличие от простого сравнения координат.
 */
export function segmentHitsSlab(
  centerX: number,
  halfWidth: number,
  slabZ: number,
  halfThickness: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): boolean {
  const near = slabZ + halfThickness;
  const far = slabZ - halfThickness;

  // Отрезок целиком по одну сторону плиты — пересечения нет.
  if ((z0 > near && z1 > near) || (z0 < far && z1 < far)) return false;

  const dz = z1 - z0;
  // Пуля идёт вдоль плиты: достаточно проверить её текущее положение.
  if (dz === 0) return Math.abs(x1 - centerX) <= halfWidth;

  // Доля пути до плоскости плиты, зажатая в пределы отрезка.
  let t = (slabZ - z0) / dz;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const crossX = x0 + (x1 - x0) * t;
  return Math.abs(crossX - centerX) <= halfWidth;
}
