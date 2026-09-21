import { BufferAttribute, BufferGeometry, Color } from 'three';

/*
 * ЗАПЕЧЁННАЯ РАСКРАСКА — общая заготовка для составных фигурок, как shadow.ts и
 * flash.ts.
 *
 * Фигурки (боец, зомби, дерево, куст, секция стены) рисуются ИНСТАНСАМИ одного
 * InstancedMesh — значит, вся фигурка обязана быть одной геометрией, и цвета
 * деталей запекаются вертексным атрибутом. Материал при этом остаётся БЕЛЫМ:
 * three умножает его на вертексный цвет и на instanceColor, поэтому вспышки
 * (flash.ts), тела зомби и тонировка по локации остаются множителями поверх
 * запечённой раскраски и ничего в геометрии не трогают.
 *
 * Склейка своя, а не BufferGeometryUtils из three/addons: нужны ровно
 * position + normal + color, и тянуть весь модуль утилит ради двадцати строк
 * незачем.
 */

/** Красит геометрию в один цвет вертексным атрибутом и разворачивает индексы. */
export function bake(source: BufferGeometry, hex: number): BufferGeometry {
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

/** Склейка окрашенных деталей в одну геометрию; исходники после неё не нужны. */
export function mergeBaked(parts: BufferGeometry[]): BufferGeometry {
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
