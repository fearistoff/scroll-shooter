import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from 'three';
import { CONFIG } from '../config';

/**
 * Мир: дорога, земля, декор, свет, туман (ТЗ раздел 3).
 *
 * Отряд стоит на месте, а мир едет на него сверху вниз со скоростью worldSpeed —
 * именно это создаёт иллюзию движения вперёд. Полотно дороги и земля статичны
 * (однотонные, движение по ним не читается), а едет декор: центральная разметка
 * и придорожные столбики. Оба набора лежат в InstancedMesh и раскладываются от
 * одного накопленного scrollOffset с заворотом по модулю — объекты не создаются
 * и не удаляются, просто переставляются матрицы.
 *
 * Геометрия коридора постоянна, меняются только фоны по локациям (позже).
 */
export class World {
  readonly group = new Group();

  /** Накопленный сдвиг декора, units. Растёт на worldSpeed за секунду. */
  private offset = 0;

  private readonly markings: InstancedMesh;
  private readonly markingCount: number;
  private readonly markingSpan: number;

  private readonly roadside: InstancedMesh;
  private readonly roadsideCount: number;
  private readonly roadsideSpan: number;

  /** Дальняя граница декора: за краем тумана его всё равно не видно. */
  private readonly decorEndZ: number;

  private readonly matrix = new Matrix4();

  constructor(scene: Scene) {
    const { world, camera, lights } = CONFIG;

    scene.background = new Color(camera.fogColor);
    scene.fog = new Fog(camera.fogColor, camera.fogNear, camera.fogFar);

    this.decorEndZ = -(camera.fogFar + 8);

    // Полотно дороги тянется от точки за камерой далеко в туман, чтобы у
    // верхнего края кадра не было видно обрыва геометрии.
    const roadCenterZ = world.despawnZ - world.roadLength / 2;

    const road = new Mesh(
      new PlaneGeometry(world.roadWidth, world.roadLength),
      new MeshStandardMaterial({ color: world.colors.road, roughness: 0.95, metalness: 0 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.z = roadCenterZ;
    this.group.add(road);

    // Земля по сторонам дороги — шире кадра, иначе у горизонта проступает фон.
    const shoulderGeometry = new PlaneGeometry(world.shoulderWidth, world.roadLength);
    const shoulderMaterial = new MeshStandardMaterial({
      color: world.colors.shoulder,
      roughness: 1,
      metalness: 0,
    });
    const shoulderX = world.roadWidth / 2 + world.shoulderWidth / 2;
    for (const side of [-1, 1]) {
      const shoulder = new Mesh(shoulderGeometry, shoulderMaterial);
      shoulder.rotation.x = -Math.PI / 2;
      shoulder.position.set(side * shoulderX, -0.05, roadCenterZ);
      this.group.add(shoulder);
    }

    // --- Центральная разметка ---
    const marks = world.markings;
    this.markingCount = Math.ceil((world.despawnZ - this.decorEndZ) / marks.dashSpacing);
    this.markingSpan = this.markingCount * marks.dashSpacing;

    this.markings = new InstancedMesh(
      new BoxGeometry(marks.dashWidth, 0.02, marks.dashLength),
      new MeshBasicMaterial({ color: marks.color }),
      this.markingCount,
    );
    this.prepareInstanced(this.markings);
    this.group.add(this.markings);

    // --- Придорожные столбики (по обеим сторонам) ---
    const side = world.roadside;
    this.roadsideCount = side.countPerSide;
    this.roadsideSpan = this.roadsideCount * side.spacingZ;

    this.roadside = new InstancedMesh(
      new BoxGeometry(side.size.x, side.size.y, side.size.z),
      new MeshStandardMaterial({ color: side.color, roughness: 0.9, metalness: 0 }),
      this.roadsideCount * 2,
    );
    this.prepareInstanced(this.roadside);
    this.group.add(this.roadside);

    this.layoutDecor();

    this.group.add(new AmbientLight(lights.ambientColor, lights.ambientIntensity));

    const dirLight = new DirectionalLight(lights.dirColor, lights.dirIntensity);
    dirLight.position.set(lights.dirPosition.x, lights.dirPosition.y, lights.dirPosition.z);
    dirLight.target.position.set(0, 0, -10);
    this.group.add(dirLight);
    this.group.add(dirLight.target);

    scene.add(this.group);
  }

  /** Накопленный сдвиг мира — для отладки и проверки скорости. */
  get scrollOffset(): number {
    return this.offset;
  }

  /** Двигает мир на игрока: декор едет вниз по экрану (в сторону +Z). */
  update(dt: number): void {
    this.offset += CONFIG.world.worldSpeed * dt;
    this.layoutDecor();
  }

  private prepareInstanced(mesh: InstancedMesh): void {
    // Матрицы переписываются каждый кадр — сообщаем это драйверу.
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Инстансы движутся, а bounding sphere меша не пересчитывается: без этого
    // сетка может целиком отсечься по фрустуму и пропасть.
    mesh.frustumCulled = false;
  }

  private layoutDecor(): void {
    this.layoutMarkings();
    this.layoutRoadside();
  }

  /**
   * z для элемента декора с заворотом по модулю: уехавший за нижний край кадра
   * возвращается наверх, поэтому конечного набора инстансов хватает навсегда.
   */
  private wrapZ(index: number, spacing: number, span: number): number {
    const raw = index * spacing + this.offset;
    const wrapped = ((raw % span) + span) % span;
    return this.decorEndZ + wrapped;
  }

  private layoutMarkings(): void {
    const { dashSpacing } = CONFIG.world.markings;

    for (let i = 0; i < this.markingCount; i++) {
      const z = this.wrapZ(i, dashSpacing, this.markingSpan);
      this.matrix.makeTranslation(0, 0.01, z);
      this.markings.setMatrixAt(i, this.matrix);
    }

    this.markings.instanceMatrix.needsUpdate = true;
  }

  private layoutRoadside(): void {
    const { spacingZ, offsetX, size } = CONFIG.world.roadside;
    const y = size.y / 2;

    let instance = 0;
    for (let i = 0; i < this.roadsideCount; i++) {
      const z = this.wrapZ(i, spacingZ, this.roadsideSpan);
      for (const side of [-1, 1]) {
        this.matrix.makeTranslation(side * offsetX, y, z);
        this.roadside.setMatrixAt(instance++, this.matrix);
      }
    }

    this.roadside.instanceMatrix.needsUpdate = true;
  }
}
