import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  SphereGeometry,
} from 'three';
import { CONFIG } from '../config';

/*
 * СТАТИЧНАЯ МОДЕЛЬ БОЙЦА (задано пользователем, 2026-08-04) — фигурка вместо
 * капсулы, собранная ПО ИКОНКЕ СТРЕЛКА (weapons.ts, SHOOTER_FIGURE): та же
 * поза стрельбы с автоматом в руках, шаг вперёд, та же палитра. Тело — из
 * усечённых пирамид-«трапеций» (см. frustum ниже), а не из голых коробок;
 * коробками остались кисти и автомат. Координаты деталей взяты прямо с
 * иконки: её система (16 единиц роста, «вправо» — вперёд) переведена в
 * мировую — y снизу вверх, вперёд это −Z (туда, где зомби), x — поперёк
 * дороги, у иконки его не было.
 *
 * ПОЧЕМУ ОДИН МЕШ, А НЕ ГРУППА. Бойцов до 23 видимых, и у союзников это
 * ИНСТАНСЫ одного InstancedMesh — значит, вся фигурка обязана быть одной
 * геометрией. Детали окрашены ВЕРТЕКСНЫМИ цветами, запечёнными при сборке:
 * материал остаётся белым, и весь существующий механизм вспышек и трупов
 * (умножение цвета материала или instanceColor) продолжает работать — он
 * теперь множитель поверх запечённой раскраски, см. makeModelFlashColor.
 *
 * Цвета читаются из CONFIG.player.model.colors ОДИН РАЗ при сборке и
 * запекаются в геометрию: крутить их на живой игре через __config нельзя,
 * нужна пересборка (перезагрузка страницы). Куртка передаётся параметром —
 * это опознавательный цвет бойца (player.colors: герой фиолетовый, союзник
 * защитный), а не часть общей палитры.
 */

/** Рост фигурки в единицах иконки — под него масштабируется всё остальное. */
const ICON_HEIGHT = 16;

/** Красит геометрию в один цвет вертексным атрибутом и разворачивает индексы. */
function bake(source: BufferGeometry, hex: number): BufferGeometry {
  // Трапеции приходят уже развёрнутыми (им нужны плоские нормали до поворотов),
  // повторный toNonIndexed на них дал бы предупреждение three в консоль.
  const geometry = source.index !== null ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();

  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  return geometry;
}

/**
 * Склейка окрашенных деталей в одну геометрию. Своя, а не BufferGeometryUtils
 * из three/addons: нужны ровно position + normal + color, и тянуть весь модуль
 * утилит ради двадцати строк незачем.
 */
function mergeBaked(parts: BufferGeometry[]): BufferGeometry {
  let total = 0;
  for (const part of parts) total += part.getAttribute('position').count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);

  let offset = 0;
  for (const part of parts) {
    const count = part.getAttribute('position').count;
    position.set(part.getAttribute('position').array as Float32Array, offset * 3);
    normal.set(part.getAttribute('normal').array as Float32Array, offset * 3);
    color.set(part.getAttribute('color').array as Float32Array, offset * 3);
    offset += count;
    part.dispose();
  }

  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(position, 3));
  merged.setAttribute('normal', new BufferAttribute(normal, 3));
  merged.setAttribute('color', new BufferAttribute(color, 3));
  return merged;
}

/**
 * Модель бойца под конкретную капсулу: фигурка того же роста
 * (length + 2 × radius) с центром в середине роста — ровно как у
 * CapsuleGeometry, поэтому вся посадка (standY, spawnScale от подошвы,
 * падение героя вокруг подошвы из FallPose) работает без правок.
 *
 * jacketHex — цвет куртки и рукавов, единственная деталь, различающая героя
 * и союзника.
 */
export function buildSoldierGeometry(
  capsule: { radius: number; length: number },
  jacketHex: number,
): BufferGeometry {
  const { skin, hair, pants, boots, rifle } = CONFIG.player.model.colors;

  const box = (
    hex: number,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ): BufferGeometry => bake(new BoxGeometry(w, h, d).translate(x, y, z), hex);

  const sphere = (hex: number, r: number, x: number, y: number, z: number): BufferGeometry =>
    // 10×7 сегментов: сферами остались только колени (голова стала угловатой,
    // см. ниже), на игровом масштабе гранёности не видно.
    bake(new SphereGeometry(r, 10, 7).translate(x, y, z), hex);

  /**
   * УСЕЧЁННАЯ ПИРАМИДА с квадратным сечением — «трапеция» в профиль: цилиндр
   * из четырёх сегментов, повёрнутый на 45°, чтобы грани смотрели по осям.
   * Из неё собрано всё тело: торс и таз (при scaleZ сечение — прямоугольник,
   * человек сверху не квадратный), сужающиеся к кистям руки, бёдра и голени,
   * лежачие клинья ботинок (rotX 90°).
   *
   * Нормали пересчитываются ПОСЛЕ разворота граней и ДО наклонов: на
   * развёрнутой геометрии computeVertexNormals даёт плоские грани (иначе
   * четырёхгранник шейдился бы «кругло»), а повороты и перенос двигают
   * готовые нормали корректно сами.
   */
  const frustum = (
    hex: number,
    rTop: number,
    rBottom: number,
    height: number,
    x: number,
    y: number,
    z: number,
    tilt: { scaleZ?: number; rotX?: number; rotY?: number } = {},
  ): BufferGeometry => {
    const geometry = new CylinderGeometry(rTop, rBottom, height, 4, 1).toNonIndexed();
    geometry.rotateY(Math.PI / 4);
    geometry.computeVertexNormals();
    if (tilt.scaleZ !== undefined && tilt.scaleZ !== 1) geometry.scale(1, 1, tilt.scaleZ);
    if (tilt.rotX) geometry.rotateX(tilt.rotX);
    if (tilt.rotY) geometry.rotateY(tilt.rotY);
    return bake(geometry.translate(x, y, z), hex);
  };

  // Детали в координатах иконки (см. шапку модуля): y — от подошвы вверх,
  // z — вперёд к врагам отрицательный, «спина» положительный, правая сторона
  // бойца — +X.
  //
  // ГОЛОВА УГЛОВАТАЯ, по эскизу пользователя (2026-08-04): лицо — трапеция,
  // СУЖАЮЩАЯСЯ к подбородку, волосы — из ДВУХ прижатых к черепу трапеций:
  // широкий козырёк макушки, нависающий над лбом и висками, и затылочный
  // клин, спускающийся за лицом до линии подбородка. Вместе в профиль они
  // дают тот самый диагональный срез от затылка к линии лба, что на эскизе и
  // на иконке (weapons.ts, SHOOTER_FIGURE); одна наклонная деталь так не
  // может — её нижний торец перпендикулярен оси, и блок отрывается от головы.
  //
  // ХВАТ (задано пользователем, 2026-08-04): автомат смещён к правому плечу,
  // держат его ДВЕ руки с разных сторон — правая короткая, изнутри на
  // рукоятке у спускового крючка, левая длинная, поперёк корпуса на цевьё.
  // Стойка стрелковая: левая нога впереди, правая сзади.
  //
  // ТЕЛО ИЗ ТРАПЕЦИЙ (задано пользователем, 2026-08-04): торс сужается от
  // плеч к поясу и ПЛОСКИЙ сверху (глубина примерно вдвое меньше ширины —
  // человек сверху не квадрат), руки и сегменты ног сужаются к кистям и
  // лодыжкам. Ноги с КОЛЕНЯМИ: бедро наклонено к колену, голень — обратно к
  // лодыжке, сустав прикрыт сферой; передняя нога согнута сильнее задней.
  // Коробками остались только кисти-кулаки и автомат — он и должен быть
  // прямоугольным.
  //
  // Наклоны посчитаны от суставов: концы каждой трапеции сходятся к точкам
  // плеча/кисти и таза/колена/лодыжки с точностью ~0.1 единицы иконки.
  const parts: BufferGeometry[] = [
    frustum(skin, 1.0, 0.7, 2.6, 0, 12.35, -0.55, { scaleZ: 0.8 }),
    frustum(hair, 1.3, 1.6, 0.9, 0, 13.45, -0.35, { scaleZ: 0.8 }),
    frustum(hair, 1.1, 0.75, 2.0, 0, 12.2, 0.55, { scaleZ: 0.65, rotX: -0.12 }),
    // Куртка: торс от плеч (2.9 × 1.6) к поясу (2.1 × 1.2) и две руки-трапеции
    // к оружию — правая коротким крюком вниз-внутрь, левая длинной диагональю
    // поперёк корпуса.
    frustum(jacketHex, 2.02, 1.5, 5.0, 0, 8.85, 0.15, { scaleZ: 0.55 }),
    frustum(jacketHex, 0.5, 0.4, 1.9, 0.9, 10.18, -0.43, { rotX: 1.12, rotY: 0.62 }),
    frustum(jacketHex, 0.5, 0.38, 4.95, -0.45, 10.28, -2.05, { rotX: 1.46, rotY: -0.38 }),
    // Кисти: правая обнимает рукоятку, левая — цевьё снизу-слева.
    box(skin, 1.0, 1.0, 0.95, 0.45, 9.75, -1.1),
    box(skin, 1.05, 1.05, 1.1, 0.45, 10.0, -4.35),
    // Автомат у правого плеча: планка ствола с прикладом, рукоятка под ней
    // и рожок между рукояткой и цевьём.
    box(rifle, 0.7, 1.0, 6.9, 0.45, 10.05, -3.25),
    box(rifle, 0.55, 1.1, 0.7, 0.45, 9.3, -1.0),
    box(rifle, 0.6, 1.9, 1.4, 0.45, 8.6, -2.9),
    // Таз — трапеция, слегка расходящаяся вниз, тоже плоская сверху.
    frustum(pants, 1.42, 1.62, 1.8, 0, 5.9, 0.15, { scaleZ: 0.6 }),
    // Передняя (левая) нога: бедро вперёд к колену, голень назад к лодыжке.
    frustum(pants, 0.78, 0.6, 2.75, -0.7, 5.0, -0.7, { rotX: 0.6 }),
    sphere(pants, 0.58, -0.7, 3.9, -1.45),
    frustum(pants, 0.55, 0.4, 2.6, -0.7, 2.6, -1.32, { rotX: -0.13 }),
    // Задняя (правая) нога: бедро назад, колено почти прямое.
    frustum(pants, 0.78, 0.6, 2.75, 0.7, 4.95, 0.62, { rotX: -0.5 }),
    sphere(pants, 0.58, 0.7, 3.7, 1.25),
    frustum(pants, 0.55, 0.4, 2.55, 0.7, 2.45, 1.5, { rotX: -0.19 }),
    // Ботинки — лежачие клинья: пятка выше и шире, к носку сходит на нет.
    frustum(boots, 0.58, 0.42, 2.2, -0.7, 0.45, -1.55, { rotX: Math.PI / 2 }),
    frustum(boots, 0.58, 0.42, 2.2, 0.7, 0.45, 1.35, { rotX: Math.PI / 2 }),
  ];

  const merged = mergeBaked(parts);

  // Центр — в середину роста (как у капсулы), затем масштаб к мировому росту.
  const scale = (capsule.length + 2 * capsule.radius) / ICON_HEIGHT;
  merged.translate(0, -ICON_HEIGHT / 2, 0);
  merged.scale(scale, scale, scale);

  return merged;
}
