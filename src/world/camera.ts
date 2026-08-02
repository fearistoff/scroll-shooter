import { PerspectiveCamera, Vector3 } from 'three';
import { CONFIG } from '../config';

/**
 * Камера сверху-сзади под наклоном (ТЗ раздел 3).
 *
 * Параметры в config.camera подобраны под портрет 0.46 так, чтобы:
 *   - линия отряда (z = 0) попадала на ~20% от низа экрана — нижняя треть;
 *   - в кадр входила дорога от z ≈ +4 (низ экрана) до z ≈ -38 (верх);
 *   - дорога шириной 10 units влезала по горизонтали с запасом на обочину.
 * Наклон получается ≈ 55° вниз.
 */
export function createGameCamera(aspect: number): PerspectiveCamera {
  const { fov, near, far, position, lookAt } = CONFIG.camera;

  const camera = new PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(position.x, position.y, position.z);
  camera.lookAt(lookAt.x, lookAt.y, lookAt.z);

  return camera;
}

/**
 * Обратная проекция: мировая точка, которая попадает в заданный пиксель холста и
 * лежит на distance units перед камерой.
 *
 * Нужна для целей, заданных ИНТЕРФЕЙСОМ, а не миром: подобранный кристалл летит в
 * плашку счётчика, а она живёт в DOM-оверлее и знает про себя только экранные
 * координаты (labels.ts делает ровно обратное — проецирует мир в экран).
 *
 * Расстояние задаётся явно, потому что одному пикселю соответствует целый луч.
 * От него зависит, каким кристалл выглядит в конце пути: чем ближе к камере, тем
 * крупнее, и подбирается оно вместе с pickupFlight.endScale.
 *
 * Матрицы камеры обновляются здесь же: функция зовётся из шага логики, то есть
 * ДО renderer.render, а без обновлённой matrixWorld unproject даёт мусор. Камера
 * в игре неподвижна, так что дороже одного вызова это не стоит.
 */
export function screenToWorld(
  camera: PerspectiveCamera,
  screenX: number,
  screenY: number,
  cssWidth: number,
  cssHeight: number,
  distance: number,
  out: Vector3,
): Vector3 {
  if (cssWidth <= 0 || cssHeight <= 0) return out;

  camera.updateMatrixWorld();

  // Пиксели холста → нормализованные координаты устройства. y перевёрнут: на
  // экране он растёт вниз, в NDC — вверх.
  out.set((screenX / cssWidth) * 2 - 1, -(screenY / cssHeight) * 2 + 1, 0.5);
  out.unproject(camera);

  // unproject даёт произвольную точку луча — нормируем направление и отмеряем
  // нужное расстояние от камеры.
  return out.sub(camera.position).normalize().multiplyScalar(distance).add(camera.position);
}
