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
 * Проекция в обе стороны для игровой камеры: мир → пиксели холста и обратно.
 *
 * Нужна там, где путь задан ЭКРАНОМ, а не миром: подобранный кристалл летит в
 * плашку счётчика, а форма его дуги («сначала вверх, потом влево») описана в
 * экранных координатах, потому что видит игрок именно их. Считать такую дугу в
 * мире нельзя: перспектива растягивает мировой x тем сильнее, чем ближе точка к
 * камере, и одна и та же мировая траектория с разных концов дороги выглядела бы
 * по-разному (ЗАМЕРЕНО: кристалл с левого края дороги уходил на конце пути
 * вправо вместо влево).
 *
 * labels.ts делает половину того же самого, но не переиспользует этот класс
 * намеренно: там проекция идёт ПОСЛЕ рендера и умеет отбрасывать точки за
 * камерой, а тут — из шага логики и с расстоянием до камеры в придачу.
 */
export class CameraSpace {
  private width = 0;
  private height = 0;

  constructor(private readonly camera: PerspectiveCamera) {}

  /**
   * Размеры холста на кадр и обновление матриц камеры.
   *
   * Матрицы обязательны: класс зовут из шага логики, то есть ДО
   * renderer.render, а без свежей matrixWorld проекция даёт мусор. Камера в игре
   * неподвижна, так что это одна проверка флага в кадр, а не пересчёт.
   */
  sync(cssWidth: number, cssHeight: number): void {
    this.width = cssWidth;
    this.height = cssHeight;
    this.camera.updateMatrixWorld();
  }

  /**
   * Мировая точка → out = (пиксель по x, пиксель по y, расстояние до камеры).
   * Расстояние возвращается тем же вызовом: полёт интерполирует и его, а второй
   * проход по той же точке стоил бы столько же, сколько сама проекция.
   */
  project(x: number, y: number, z: number, out: Vector3): Vector3 {
    out.set(x, y, z);
    const distance = out.distanceTo(this.camera.position);

    out.project(this.camera);
    return out.set(
      (out.x * 0.5 + 0.5) * this.width,
      (-out.y * 0.5 + 0.5) * this.height,
      distance,
    );
  }

  /**
   * Пиксель холста + расстояние от камеры → мировая точка.
   *
   * Расстояние задаётся явно, потому что одному пикселю соответствует целый луч.
   * От него зависит, каким предмет выглядит в этой точке: чем ближе к камере,
   * тем крупнее, и подбирается оно вместе с pickupFlight.endScale.
   */
  unproject(screenX: number, screenY: number, distance: number, out: Vector3): Vector3 {
    if (this.width <= 0 || this.height <= 0) return out;

    // Пиксели холста → нормализованные координаты устройства. y перевёрнут: на
    // экране он растёт вниз, в NDC — вверх.
    out.set((screenX / this.width) * 2 - 1, -(screenY / this.height) * 2 + 1, 0.5);
    out.unproject(this.camera);

    // unproject даёт произвольную точку луча — нормируем направление и отмеряем
    // нужное расстояние от камеры.
    const position = this.camera.position;
    return out.sub(position).normalize().multiplyScalar(distance).add(position);
  }
}
