import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import { CONFIG } from '../config';

/**
 * ТЕНИ НА ЗЕМЛЕ — плоские фигуры под объектами (задано пользователем,
 * 2026-08-13). Общий модуль-заготовка, как flash.ts и fall.ts: столбики берут
 * отсюда четырёхугольник (world.ts), стрелки и зомби — овал с градиентом
 * (squad.ts, enemies.ts).
 *
 * ПОЧЕМУ НЕ КАРТЫ ТЕНЕЙ РЕНДЕРА. Их включение стоит отдельного прохода сцены на
 * источник, а рисовать нужно одну проекцию под ОДНИМ неподвижным углом солнца —
 * геометрия такой тени считается один раз при сборке и дальше просто едет
 * матрицей инстанса вместе с объектом.
 *
 * УГОЛ СОЛНЦА БЕРЁТСЯ ИЗ СВЕТА (CONFIG.lights.dirPosition и dirTarget), а не
 * задан отдельным числом: у света и у теней обязано быть одно солнце. Отсюда и
 * поле dirTarget в конфиге — раньше цель светильника стояла числом в world.ts.
 *
 * Формы лежат в плоскости XZ на y = 0 и наклона по y не имеют: их поднимает над
 * землёй тот, кто ставит (CONFIG.shadows.liftY) — плоскости под столбиками
 * (обочина) и под фигурками (дорога) разной высоты.
 */

/**
 * Доля длины овала, на которой стоит центр радиального градиента (задано
 * пользователем: «радиальный градиент от 1/4 продольной части овала»). 0 — у
 * подошв, 1 — у дальнего конца тени.
 *
 * Он же — точка, которую buildFigureShadowGeometry ставит в начало координат,
 * то есть под подошвы: самое тёмное место тени у ног, а не в середине пятна.
 */
const OVAL_FOCUS = 0.25;

/** Сторона текстуры градиента в пикселях. */
const OVAL_TEXTURE_SIZE = 128;

/**
 * Сдвиг тени на ЕДИНИЦУ ВЫСОТЫ объекта, units в плоскости XZ.
 *
 * Ход луча — (цель − позиция) светильника; точка на высоте h отбрасывает тень на
 * h × (dirXZ / −dirY). При нынешних числах это (0.333, −0.667), длина 0.745 —
 * тени вытянуты вправо и в глубину кадра.
 *
 * Солнце строго в зените или ниже горизонта (dirY ≥ 0) — вырожденный случай:
 * тень становится следом объекта без сдвига, лишь бы не делить на ноль.
 */
export function sunShadowOffset(): { x: number; z: number } {
  const { dirPosition, dirTarget } = CONFIG.lights;
  const drop = dirPosition.y - dirTarget.y;
  if (drop <= 0) return { x: 0, z: 0 };
  return { x: (dirTarget.x - dirPosition.x) / drop, z: (dirTarget.z - dirPosition.z) / drop };
}

/** Направление тени (единичное) и поперечина к нему — для сборки форм. */
function shadowAxes(offsetX: number, offsetZ: number): {
  dirX: number;
  dirZ: number;
  perpX: number;
  perpZ: number;
  yaw: number;
} {
  const length = Math.hypot(offsetX, offsetZ);
  // Вырожденный случай (солнце в зените): направление берётся любое, форма при
  // нулевом сдвиге всё равно симметрична.
  const dirX = length > 0 ? offsetX / length : 0;
  const dirZ = length > 0 ? offsetZ / length : -1;
  return {
    dirX,
    dirZ,
    perpX: -dirZ,
    perpZ: dirX,
    // Поворот вокруг Y, переводящий −Z (куда смотрит верх положенной плашмя
    // плоскости) в направление тени: −sin θ = dirX, −cos θ = dirZ.
    yaw: Math.atan2(-dirX, -dirZ),
  };
}

/**
 * ЧЕТЫРЁХУГОЛЬНИК — проекция коробки на землю под углом солнца (тень столбика).
 *
 * Строго тень коробки — шестиугольник (след основания плюс след верха и
 * перемычка), но по требованию нужен четырёхугольник, и им берётся
 * параллелограмм: поперёк тени — полная ширина следа коробки, вдоль — от
 * основания до проекции верхней грани. От шестиугольника он отличается только
 * двумя уголками у самого столбика, которые столбик и закрывает.
 */
export function buildBoxShadowGeometry(size: { x: number; y: number; z: number }): BufferGeometry {
  const offset = sunShadowOffset();
  const offsetX = offset.x * size.y;
  const offsetZ = offset.z * size.y;
  const { dirX, dirZ, perpX, perpZ } = shadowAxes(offsetX, offsetZ);

  const halfX = size.x / 2;
  const halfZ = size.z / 2;
  // Габарит следа коробки вдоль тени и поперёк неё: проекция прямоугольника на
  // эти оси. Столбик в плане квадратный, но повёрнутая тень всё равно шире его
  // стороны, и это нужно учесть — иначе тень окажется уже столбика.
  const along = halfX * Math.abs(dirX) + halfZ * Math.abs(dirZ);
  const across = halfX * Math.abs(perpX) + halfZ * Math.abs(perpZ);

  // Обход — против часовой при взгляде сверху, чтобы нормаль смотрела в +Y и
  // четырёхугольник был виден лицевой стороной.
  const positions = new Float32Array([
    -dirX * along + perpX * across, 0, -dirZ * along + perpZ * across,
    offsetX + dirX * along + perpX * across, 0, offsetZ + dirZ * along + perpZ * across,
    offsetX + dirX * along - perpX * across, 0, offsetZ + dirZ * along - perpZ * across,
    -dirX * along - perpX * across, 0, -dirZ * along - perpZ * across,
  ]);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/**
 * ОВАЛ под фигурку — под тем же углом солнца, что тень столбика: длинная ось
 * лежит вдоль тени, длина считается от роста, ширина равна ширине фигурки.
 *
 * НАЧАЛО КООРДИНАТ ГЕОМЕТРИИ — В ФОКУСЕ ГРАДИЕНТА (OVAL_FOCUS длины от ближнего
 * конца), а не в центре овала: ставится тень по подошвам фигурки, и самое тёмное
 * место должно оказаться под ними. Поэтому мешу достаточно позиции объекта, а
 * сдвиг пятна вдоль тени уже запечён.
 *
 * Масштаб инстанса растягивает и сдвиг: тень крупного зомби длиннее ровно
 * настолько, насколько он выше, — отдельного расчёта на вид не нужно.
 */
export function buildFigureShadowGeometry(height: number, width: number): BufferGeometry {
  const offset = sunShadowOffset();
  const offsetX = offset.x * height;
  const offsetZ = offset.z * height;
  const { dirX, dirZ, yaw } = shadowAxes(offsetX, offsetZ);

  // Длина — тень роста плюс собственный след фигурки: иначе овал начинался бы
  // ровно под подошвами и у ног читался бы обрубленным.
  const length = Math.hypot(offsetX, offsetZ) + width;
  const shift = length * (0.5 - OVAL_FOCUS);

  const geometry = new PlaneGeometry(width, length);
  // Плашмя на землю: верх плоскости (v = 1 текстуры) уезжает в −Z, нормаль в +Y.
  geometry.rotateX(-Math.PI / 2);
  // Длинной осью вдоль тени — теперь v = 1 смотрит от подошв в сторону тени.
  geometry.rotateY(yaw);
  geometry.translate(shift * dirX, 0, shift * dirZ);
  return geometry;
}

/** Текстура овала: одна на всю игру, считается при первом обращении. */
let cachedOvalTexture: CanvasTexture | null = null;

/**
 * Текстура овала: АЛЬФА-МАСКА с радиальным градиентом. Одна на всю игру —
 * овал у всех фигурок один и тот же, разный только масштаб инстанса.
 *
 * Считается по пикселям, а не canvas-градиентом, ровно по двум причинам:
 * градиент у canvas круглый, а нужен вписанный в овал (иначе у краёв пятна
 * остаётся ступенька непрозрачности), и центр у него не в середине, а на
 * OVAL_FOCUS — тогда «дойти до нуля точно на границе» удаётся только счётом
 * расстояния до границы вдоль каждого луча.
 *
 * Овал в геометрии растянут по длинной оси, поэтому в квадратной текстуре
 * границей служит вписанная ОКРУЖНОСТЬ: растяжение превращает её в тот самый
 * овал, а концентрические окружности градиента — в концентрические овалы.
 */
function ovalShadowTexture(): CanvasTexture {
  if (cachedOvalTexture !== null) return cachedOvalTexture;

  const size = OVAL_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(size, size);
  const data = image.data;

  // Фокус в нормированных координатах (границей служит единичная окружность с
  // центром в нуле): поперёк он в нуле, вдоль — на OVAL_FOCUS.
  const focusV = OVAL_FOCUS * 2 - 1;

  for (let py = 0; py < size; py++) {
    // v = 0 у подошв. CanvasTexture по умолчанию переворачивает картинку по
    // вертикали (flipY), поэтому верхняя строка канваса — это v = 1.
    const v = (1 - (py + 0.5) / size) * 2 - 1;
    for (let px = 0; px < size; px++) {
      const u = ((px + 0.5) / size) * 2 - 1;
      const i = (py * size + px) * 4;

      // Цвет тени задаёт материал, текстура несёт только альфу — поэтому белый.
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;

      if (u * u + v * v >= 1) {
        data[i + 3] = 0;
        continue;
      }

      let rayU = u;
      let rayV = v - focusV;
      const distance = Math.hypot(rayU, rayV);
      if (distance < 1e-6) {
        data[i + 3] = 255;
        continue;
      }
      rayU /= distance;
      rayV /= distance;

      // Где луч из фокуса упирается в границу: |focus + t·ray| = 1.
      const b = focusV * rayV;
      const edge = -b + Math.sqrt(b * b + 1 - focusV * focusV);
      data[i + 3] = Math.round(255 * Math.max(0, 1 - distance / edge));
    }
  }

  context.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  cachedOvalTexture = texture;
  return texture;
}

/**
 * Материал плоской тени: чернота с общей непрозрачностью, без градиента (тень
 * столбика).
 *
 * depthWrite выключен, потому что теней на земле много и они пересекаются: с
 * записью глубины пара наложившихся пятен спорила бы за z-буфер и мигала. Тест
 * глубины при этом остаётся — тень лежит на земле и не может оказаться поверх
 * того, кто её отбрасывает.
 */
export function createFlatShadowMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: CONFIG.shadows.opacity,
    depthWrite: false,
  });
}

/** Материал овальной тени: та же чернота, но альфа берётся из градиента. */
export function createOvalShadowMaterial(): MeshBasicMaterial {
  const material = createFlatShadowMaterial();
  material.map = ovalShadowTexture();
  return material;
}
