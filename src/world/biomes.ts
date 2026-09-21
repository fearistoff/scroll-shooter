/*
 * ОПИСАНИЯ ЛОКАЦИЙ (задано пользователем, 2026-09-21): пустыня, лес, город.
 *
 * Локация — это ПАЛИТРА И НАБОР ДЕКОРА, и ничего больше: ширина дороги, линии
 * спавна, скорость мира и вся боевая геометрия от неё не зависят. Иначе выбор
 * обстановки волны превратился бы в скрытый балансный модификатор, а он
 * случайный (см. pickBiome) — игрок не выбирал бы его и не смог бы к нему
 * готовиться.
 *
 * ПОЧЕМУ ОДИН НАБОР МЕШЕЙ НА ВСЕ ТРИ. World создаёт по InstancedMesh на вид
 * декора один раз и дальше только переставляет матрицы и красит instanceColor:
 * пустыня и лес делят и куст, и дерево, отличаясь цветом, масштабом и
 * плотностью. Нового меша требует только городская стена — её силуэт ничем из
 * растительности не изображается.
 *
 * ГУСТОТА ЗАДАНА ДОЛЕЙ, А НЕ ЧИСЛОМ. density — вероятность, что очередное место
 * в ряду занято: 0 гасит вид целиком (в городе нет деревьев), 1 заполняет ряд
 * подряд. Число инстансов при этом постоянно — лишние прячутся нулевым
 * масштабом, и переключение локации не пересоздаёт меши.
 */

/** Виды придорожного декора. Порядок — только для читаемости. */
export type DecorKind = 'grass' | 'bush' | 'tree' | 'conifer' | 'deadTree' | 'rock' | 'cityWall';

/** Как локация раскладывает один вид декора. */
export interface DecorLayer {
  /** Доля занятых мест в ряду, 0…1. 0 — вида в локации нет. */
  density: number;
  /** Множитель масштаба: вокруг этого значения идёт разброс ±scaleJitter. */
  scale: number;
  scaleJitter: number;
  /** Цвет тонировки (instanceColor поверх запечённой раскраски). */
  color: number;
  /**
   * Разброс яркости тонировки, доля: соседние экземпляры одного вида чуть
   * светлее и темнее друг друга, иначе ряд читается как копии одного объекта.
   */
  colorJitter: number;
}

export interface Biome {
  id: 'desert' | 'forest' | 'city';
  /** Человеческое название — для отладочного снимка. */
  title: string;
  /** Цвет тумана и фона: им же закрашен горизонт. */
  fogColor: number;
  road: number;
  shoulder: number;
  /** Цвет придорожных столбиков и центральной разметки. */
  roadside: number;
  marking: number;
  /** Насколько локация освещена: множитель к интенсивности обоих источников. */
  lightScale: number;
  decor: Record<DecorKind, DecorLayer>;
}

/** Пустой слой — «этого вида в локации нет». */
const NONE: DecorLayer = { density: 0, scale: 1, scaleJitter: 0, color: 0xffffff, colorJitter: 0 };

/**
 * ПУСТЫНЯ — исходная обстановка прототипа, её палитра и оставлена без изменений
 * (road 0x3a3833, shoulder 0x4a3f2e, туман 0x14161c): по ней откалиброваны
 * контраст фигурок и заметность теней.
 *
 * Растительность коричнево-жёлтая и редкая: сухая трава, кусты с малым числом
 * листьев (тот же меш куста при меньшем масштабе — крона получается жиже) и
 * деревья без листвы. Камни — чтобы обочина не была рядом одинаковых кустов.
 */
const DESERT: Biome = {
  id: 'desert',
  title: 'Пустошь',
  fogColor: 0x14161c,
  road: 0x3a3833,
  shoulder: 0x4a3f2e,
  roadside: 0x9a8f72,
  marking: 0xb8b2a0,
  lightScale: 1,
  decor: {
    grass: { density: 0.6, scale: 0.75, scaleJitter: 0.25, color: 0x8a7538, colorJitter: 0.2 },
    bush: { density: 0.45, scale: 0.8, scaleJitter: 0.25, color: 0x6b6a30, colorJitter: 0.22 },
    tree: NONE,
    conifer: NONE,
    deadTree: { density: 0.5, scale: 0.95, scaleJitter: 0.2, color: 0x8d7a5a, colorJitter: 0.15 },
    rock: { density: 0.22, scale: 0.9, scaleJitter: 0.35, color: 0x5f574a, colorJitter: 0.18 },
    cityWall: NONE,
  },
};

/**
 * ЛЕС — зелёная и плотная локация: деревьев больше всего, трава гуще, сухих
 * деревьев нет вовсе.
 *
 * Земля и туман уведены в зелёный, дорога чуть темнее пустынной: асфальт в тени
 * крон. Освещение приглушено (0.9) — под пологом леса, но не настолько, чтобы
 * фигурки потеряли контраст: ниже 0.85 полоски HP начинают спорить с фоном.
 */
const FOREST: Biome = {
  id: 'forest',
  title: 'Лес',
  fogColor: 0x101c14,
  road: 0x35362f,
  shoulder: 0x2f4426,
  roadside: 0x8e9478,
  marking: 0xc2c4a6,
  lightScale: 0.9,
  decor: {
    grass: { density: 0.95, scale: 1, scaleJitter: 0.3, color: 0x3f7a2c, colorJitter: 0.25 },
    bush: { density: 0.8, scale: 1.1, scaleJitter: 0.3, color: 0x3e7a34, colorJitter: 0.25 },
    tree: { density: 0.85, scale: 1.05, scaleJitter: 0.25, color: 0x3c7a30, colorJitter: 0.22 },
    conifer: { density: 0.5, scale: 1, scaleJitter: 0.25, color: 0x2c5f34, colorJitter: 0.2 },
    deadTree: NONE,
    rock: { density: 0.12, scale: 0.85, scaleJitter: 0.3, color: 0x474d42, colorJitter: 0.15 },
    cityWall: NONE,
  },
};

/**
 * ГОРОД — бесконечные серые стены слева и справа, окна и двери на обращённых к
 * дороге гранях. Растительности почти нет: редкая трава в трещинах асфальта.
 *
 * Стена стоит вплотную за столбиками и закрывает всю обочину, поэтому кусты и
 * деревья там всё равно не видны — их density 0 не только по смыслу, но и ради
 * пустой работы раскладки.
 */
const CITY: Biome = {
  id: 'city',
  title: 'Город',
  fogColor: 0x171a1f,
  road: 0x38383a,
  shoulder: 0x45454a,
  roadside: 0x8f9096,
  marking: 0xd0cfc4,
  lightScale: 0.95,
  decor: {
    grass: { density: 0.25, scale: 0.7, scaleJitter: 0.25, color: 0x4d5a3a, colorJitter: 0.25 },
    bush: NONE,
    tree: NONE,
    conifer: NONE,
    deadTree: NONE,
    rock: NONE,
    // Сплошная стена: место в ряду занято всегда, разброс масштаба нулевой —
    // секции обязаны стыковаться, а не стоять разной высоты.
    cityWall: { density: 1, scale: 1, scaleJitter: 0, color: 0x8b8d94, colorJitter: 0.08 },
  },
};

export const BIOMES = [DESERT, FOREST, CITY] as const;

/** Локация первой волны. Забег всегда начинается с неё — пустыня знакома игроку. */
export const STARTING_BIOME = DESERT;

/**
 * Локация следующей волны — случайная, но НЕ ТА ЖЕ, ЧТО СЕЙЧАС (решение
 * пользователя): повтор подряд читался бы как «локация не сменилась», то есть
 * как пропущенный переход, а не как выпавший дубль.
 */
export function pickBiome(current: Biome): Biome {
  const others = BIOMES.filter((biome) => biome !== current);
  return others[Math.floor(Math.random() * others.length)] ?? STARTING_BIOME;
}
