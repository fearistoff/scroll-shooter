import { OctahedronGeometry, Vector3, type Scene } from 'three';
import { CONFIG } from '../config';
import { PickupPool, type PickupMotion } from './pickups';

/**
 * Кристаллы EXP (ТЗ раздел 9): падают с убитых зомби и разбитых бочек, едут к
 * отряду и попадают в счётчик забега.
 *
 * Всё движение и сбор — в общем PickupPool: то же самое делают монеты денег.
 * Здесь остались только вид и числа кристалла. Собирается автоматически на линии
 * отряда: подбирать вручную по ТЗ не нужно.
 */
export class CrystalPool extends PickupPool {
  constructor(scene: Scene) {
    const { crystalSize, crystalColor, poolSize } = CONFIG.exp;

    super(scene, {
      // Октаэдр читается как кристалл и стоит дешевле любой огранки.
      geometry: new OctahedronGeometry(crystalSize),
      color: crystalColor,
      poolSize,
      // Ось наклонена: при вращении вокруг неё грани попеременно ловят свет, и
      // кристалл переливается, а не просто крутится.
      spinAxis: new Vector3(0.3, 1, 0.15),
    });
  }

  protected get motion(): PickupMotion {
    return CONFIG.exp;
  }
}
