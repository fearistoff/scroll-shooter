import { PerspectiveCamera } from 'three';
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
