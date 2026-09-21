import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
} from 'three';
import { bake, mergeBaked } from '../entities/baked';

/*
 * ПРИДОРОЖНЫЙ ДЕКОР — травинки, кусты, деревья, камни и секция городской стены
 * (задано пользователем, 2026-09-21).
 *
 * Каждый вид — ОДНА геометрия с запечённой вертексной раскраской (baked.ts): их
 * рисует по InstancedMesh на вид (world.ts), а цвет локации приходит поверх
 * через instanceColor.
 *
 * ПОЧЕМУ ЗЕЛЕНЬ ЗАПЕКАЕТСЯ БЕЛОЙ. Листва, крона и тело стены в геометрии белые —
 * собственно цвет им задаёт локация через instanceColor, и одно и то же дерево
 * читается и как сухой остов пустыни, и как зелёное лесное. Ствол и ветки
 * запечены коричневым: они обязаны отличаться от кроны на любой палитре, и
 * тонируются тем же множителем, оставаясь темнее её.
 *
 * ФОРМЫ НАМЕРЕННО ГРУБЫЕ (икосаэдр detail 0, конус на 7 сегментов): объект виден
 * с высоты 20 units, занимает десятки пикселей, детализация в нём пропадает, а
 * инстансов на дороге до сотни на вид.
 *
 * ВСЕ ФИГУРКИ СТОЯТ ОСНОВАНИЕМ В y = 0 — world.ts ставит их прямо на обочину без
 * поправки на высоту, а масштаб инстанса не уводит их под землю.
 */

/** Цвет древесины — единственная деталь, чей тон не отдан локации целиком. */
const WOOD = 0x6b5a45;
/** Белый: цвет этих деталей задаёт локация через instanceColor. */
const TINTED = 0xffffff;

/** Двигает и наклоняет готовую деталь на месте: сперва наклон, потом сдвиг. */
function place(
  geometry: BufferGeometry,
  x: number,
  y: number,
  z: number,
  lean = 0,
  yaw = 0,
): BufferGeometry {
  const matrix = new Matrix4().makeRotationY(yaw);
  matrix.multiply(new Matrix4().makeRotationZ(lean));
  matrix.setPosition(x, y, z);
  return geometry.applyMatrix4(matrix);
}

/**
 * ПУЧОК ТРАВЫ — пять лезвий разного наклона и разворота, высота ровно 1.
 *
 * Не одна плоскость: одиночное лезвие с камеры сверху может смотреть почти
 * ребром и пропадать, а пять под разными разворотами всегда дают заметное пятно.
 * Единичная высота — чтобы масштаб инстанса задавал её напрямую.
 *
 * Лезвие ШИРОКОЕ (0.22 units при высоте 1). На обочине 1 unit по горизонтали —
 * это порядка десятка пикселей кадра, и узкое лезвие превращалось в волосок,
 * который читался как случайный штрих, а не как трава; наклон при этом заметно
 * сильнее вертикального, иначе пучок с камеры сверху виден одними торцами.
 */
export function buildGrassGeometry(): BufferGeometry {
  const blades: BufferGeometry[] = [];

  for (const [lean, yaw] of [
    [0.3, 0],
    [-0.42, 1.1],
    [0.15, 2.3],
    [-0.25, 3.6],
    [0.38, 5.0],
  ] as const) {
    // Лезвие — плоская коробка с небольшой толщиной, чтобы не исчезать при
    // взгляде точно в ребро.
    blades.push(place(bake(new BoxGeometry(0.22, 1, 0.05), TINTED), 0, 0.5, 0, lean, yaw));
  }

  return mergeBaked(blades);
}

/**
 * КУСТ — три шарика на коротком стволике, габарит около 1×0.8×1.
 *
 * Пустынный и лесной куст — ОДНА геометрия: сухость пустынного делают цвет и
 * меньший масштаб из описания локации, а не отдельный меш.
 */
export function buildBushGeometry(): BufferGeometry {
  return mergeBaked([
    place(bake(new CylinderGeometry(0.05, 0.07, 0.24, 5), WOOD), 0, 0.12, 0),
    place(bake(new IcosahedronGeometry(0.34, 0), TINTED), 0, 0.46, 0),
    place(bake(new IcosahedronGeometry(0.26, 0), TINTED), 0.26, 0.34, 0.12),
    place(bake(new IcosahedronGeometry(0.22, 0), TINTED), -0.22, 0.38, -0.14),
  ]);
}

/**
 * ЛИСТВЕННОЕ ДЕРЕВО — ствол и крона из трёх шаров, высота около 3.4.
 *
 * Крона шарами, а не конусом: конус читается как хвоя, а по описанию лес общий.
 * Высота выбрана так, чтобы дерево было заметно выше зомби (1.8) и при этом не
 * загораживало дорогу — стоит оно за обочиной, вне коридора боя.
 */
export function buildTreeGeometry(): BufferGeometry {
  return mergeBaked([
    place(bake(new CylinderGeometry(0.11, 0.18, 2.0, 6), WOOD), 0, 1.0, 0),
    place(bake(new IcosahedronGeometry(0.85, 0), TINTED), 0, 2.5, 0),
    place(bake(new IcosahedronGeometry(0.6, 0), TINTED), 0.6, 2.1, 0.25),
    place(bake(new IcosahedronGeometry(0.52, 0), TINTED), -0.55, 2.2, -0.3),
  ]);
}

/**
 * ХВОЙНОЕ ДЕРЕВО — ствол и два конуса, высота около 3.5.
 *
 * Нужно лесу ради разнообразия силуэта: ряд одинаковых шаров-крон читается как
 * повтор одного меша, конус этот ряд ломает.
 */
export function buildConiferGeometry(): BufferGeometry {
  return mergeBaked([
    place(bake(new CylinderGeometry(0.09, 0.15, 1.2, 6), WOOD), 0, 0.6, 0),
    place(bake(new ConeGeometry(0.95, 1.8, 7), TINTED), 0, 1.7, 0),
    place(bake(new ConeGeometry(0.7, 1.5, 7), TINTED), 0, 2.7, 0),
  ]);
}

/**
 * СУХОЕ ДЕРЕВО — ствол с голыми ветками, без кроны. Высота около 3.
 *
 * Ветки развёрнуты веером вокруг ствола: с камеры сверху читается именно
 * разброс в плане, вертикальный наклон почти не виден. Наклон 0.95 рад (54°) —
 * ветка уходит вбок примерно настолько же, насколько вверх.
 */
export function buildDeadTreeGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [
    place(bake(new CylinderGeometry(0.1, 0.19, 2.4, 6), WOOD), 0, 1.2, 0),
  ];

  const lean = 0.95;
  for (const [yaw, y, length] of [
    [0.4, 1.7, 1.2],
    [2.5, 2.1, 1.0],
    [4.3, 1.5, 0.9],
    [5.4, 2.3, 0.8],
  ] as const) {
    // Наклон вокруг Z кладёт ветку набок, разворот вокруг Y разносит их по кругу;
    // центр детали поднимается на половину её вертикальной проекции, иначе
    // наклонённая ветка нижним концом ушла бы в ствол ниже точки крепления.
    const branch = bake(new CylinderGeometry(0.035, 0.07, length, 4), WOOD);
    place(branch, 0, y + (Math.cos(lean) * length) / 2, 0, lean, yaw);
    parts.push(branch);
  }

  return mergeBaked(parts);
}

/**
 * КАМЕНЬ — сплюснутый икосаэдр. Пустыне нужен объект, не похожий на растение,
 * иначе обочина читается как редкий ряд одинаковых кустов.
 */
export function buildRockGeometry(): BufferGeometry {
  const rock = new IcosahedronGeometry(0.5, 0);
  rock.scale(1, 0.6, 1.1);
  // Икосаэдр центрирован — поднимаем, чтобы камень стоял на земле, а не врос в неё.
  rock.translate(0, 0.3, 0);
  return bake(rock, TINTED);
}

/**
 * СЕКЦИЯ ГОРОДСКОЙ СТЕНЫ — глухой короб с окнами и дверью на грани, обращённой к
 * дороге. Длина по z равна шагу раскладки, поэтому секции подряд складываются в
 * бесконечную стену без разрывов.
 *
 * РАЗМЕРЫ ПРОЁМОВ ВЫБРАНЫ ПО ЗАМЕРУ ПРОЕКЦИИ, а не на глаз. На внутренней грани
 * (x = 7) один unit высоты занимает 14–19 px по вертикали кадра, один unit
 * длины — 9–28 px в зависимости от z (замерено проекцией игровой камеры на
 * 500×860). Окно 0.7 × 0.55 units, стоявшее здесь до замера, давало пятно
 * примерно 12 × 8 px и на дороге не читалось вовсе; нынешние 1.3 × 1.0 дают
 * 20 × 15 px и выше — проём виден как проём.
 *
 * Окна и дверь — накладные плашки чуть перед гранью, а не вырезы: вычитание
 * потребовало бы CSG, а плашка на 0.03 units перед стеной с камеры сверху
 * читается так же и стоит пару треугольников.
 *
 * ТЁМНЫЕ ДЕТАЛИ ЗАПЕЧЕНЫ ТЁМНЫМИ, а не белыми: их тон не должен зависеть от
 * тона стены — иначе на светлой локации окна светлели бы вместе с ней и пропали.
 *
 * ВЫСОТА СЕКЦИИ ПРИХОДИТ ПАРАМЕТРОМ: ровная стена одной высоты читается как
 * забор, а не как застройка, поэтому world.ts собирает несколько вариантов
 * секции и чередует их (см. CITY_WALL_HEIGHTS).
 */
export function buildCityWallGeometry(
  width: number,
  height: number,
  length: number,
): BufferGeometry {
  const parts: BufferGeometry[] = [
    place(bake(new BoxGeometry(width, height, length), TINTED), 0, height / 2, 0),
  ];

  const faceX = -width / 2 - 0.03;

  // Парапет по верху: полоска чуть шире короба. Без неё верхняя грань сливается
  // с фоном, и стена теряет край — она ведь видна сверху почти плашмя.
  parts.push(
    place(bake(new BoxGeometry(width + 0.3, 0.25, length), 0xffffff), 0, height - 0.12, 0),
  );

  // Окна сеткой, а не вразнобой: случайные проёмы на соседних секциях не
  // складываются в дом, а стена из них перестаёт читаться как застройка.
  // Этажей столько, сколько влезает по 1.7 units от двери до парапета.
  const floors = Math.max(1, Math.floor((height - 2.4) / 1.7));
  const windowsPerFloor = 2;
  for (let floor = 0; floor < floors; floor++) {
    for (let col = 0; col < windowsPerFloor; col++) {
      // Окна разнесены по длине секции симметрично относительно её середины.
      const offsetZ = (col - (windowsPerFloor - 1) / 2) * (length / windowsPerFloor);
      const pane = bake(new BoxGeometry(0.06, 1.3, 1.0), 0x23282f);
      parts.push(place(pane, faceX, 2.2 + floor * 1.7, offsetZ));
    }
  }

  // Дверь — в середине секции, у самой земли.
  parts.push(place(bake(new BoxGeometry(0.06, 1.7, 1.0), 0x1b1f25), faceX, 0.85, 0));

  return mergeBaked(parts);
}
