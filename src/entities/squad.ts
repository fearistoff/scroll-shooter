import {
  CapsuleGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import type { BonusReceiver } from './barrels';
import type { BossTarget } from './boss';
import type { BulletPool } from './bullets';
import type { SquadTarget } from './enemies';
import { makeFlashColor } from './flash';
import type { GateTarget } from './gates';
import type { MineField } from './mines';
import {
  isSpecialWeapon,
  weaponDamage,
  weaponRange,
  WeaponState,
  type WeaponId,
} from './weapons';

/** Доп. стрелок. Главный герой хранится отдельно — он не взаимозаменяем. */
interface Ally {
  hp: number;
  weapon: WeaponState;
  /** Сколько секунд ещё показывать полоску HP. Ставится при уроне. */
  hpBarLeft: number;
  /** Остаток вспышки от урона (ui.damageFlash). Ставится там же. */
  flashLeft: number;
}

/**
 * Отряд стрелков (ТЗ раздел 5): главный герой впереди и строй доп. стрелков за ним.
 *
 * Строй — «тупой клин»: первый ряд до 4 бойцов, последующие до 7, ряды уходят
 * назад по +Z. Форма клина получается сама из того, что первый ряд узкий.
 *
 * ВИЗУАЛЬНЫЙ ПОТОЛОК. Рисуются только бойцы, влезающие в rowSizes рядов
 * (4 + 5×7 = 39). Остальные существуют как элементы того же массива: стреляют,
 * но не имеют модели и недосягаемы для зомби — они физически позади строя.
 * Порядок массива и есть порядок строя, поэтому при гибели видимого бойца
 * splice сдвигает всех вперёд и «невидимый» автоматически становится видимым.
 *
 * Позиция отряда хранится в ПРОЦЕНТАХ хода (0 — левый предел, 50 — центр,
 * 100 — правый), мировой x из них выводится.
 */
export class Squad implements SquadTarget, BonusReceiver, GateTarget, BossTarget {
  /** Капсула главного героя — заметно крупнее союзников. */
  readonly heroMesh: Mesh;

  /** HP главного героя. Его смерть заканчивает забег (ТЗ раздел 15). */
  heroHp = CONFIG.player.heroHp;

  /** Оружие главного героя. */
  readonly heroWeapon: WeaponState;

  /** Сколько секунд ещё показывать полоску HP героя. */
  private heroHpBarLeft = 0;
  /** Остаток вспышки героя от урона (ui.damageFlash). */
  private heroFlashLeft = 0;

  private readonly allyMesh: InstancedMesh;
  private readonly matrix = new Matrix4();
  private readonly allies: Ally[] = [];

  /** Материал героя — по нему переключается его вспышка (он один, не инстанс). */
  private readonly heroMaterial: MeshStandardMaterial;
  /** Цвета для вспышек. Заведены один раз: раскладка строя идёт каждый кадр. */
  private readonly heroColor = new Color(CONFIG.player.colors.hero);
  private readonly allyColor = new Color(CONFIG.player.colors.ally);
  // Вспышка — светлый оттенок СВОЕГО цвета, поэтому у героя и союзника разная.
  private readonly heroFlash = makeFlashColor(CONFIG.player.colors.hero);
  private readonly allyFlash = makeFlashColor(CONFIG.player.colors.ally);

  /** Общее стрелковое оружие отряда (ТЗ раздел 6: подобрал — у всех). */
  private commonWeapon: WeaponId;

  private percent = 50;

  // Переиспользуемые поля вместо возврата объекта из allyOffset — раскладка
  // строя считается для каждого бойца каждый кадр.
  private offsetX = 0;
  private offsetZ = 0;

  /**
   * Куда перенаправлен огонь. null — стрелять вперёд.
   * Во время боссфайта отряд авто-наводится на босса (ТЗ раздел 10).
   */
  private aimX: number | null = null;
  private aimZ: number | null = null;

  constructor(
    scene: Scene,
    private readonly bullets: BulletPool,
    private readonly mines: MineField,
  ) {
    const { heroCapsule, allyCapsule, colors, startWeapon } = CONFIG.player;

    this.commonWeapon = startWeapon as WeaponId;
    this.heroWeapon = new WeaponState(this.commonWeapon);

    // Материал героя держим ссылкой: его цвет переключается на вспышку при уроне.
    this.heroMaterial = new MeshStandardMaterial({
      color: colors.hero,
      roughness: 0.7,
      metalness: 0,
    });
    this.heroMesh = new Mesh(
      new CapsuleGeometry(heroCapsule.radius, heroCapsule.length, 4, 12),
      this.heroMaterial,
    );
    // Капсула центрируется по середине: поднимаем на пол-высоты, чтобы ноги
    // стояли на дороге (y = 0).
    this.heroMesh.position.set(0, heroCapsule.length / 2 + heroCapsule.radius, 0);
    scene.add(this.heroMesh);

    this.allyMesh = new InstancedMesh(
      new CapsuleGeometry(allyCapsule.radius, allyCapsule.length, 4, 10),
      // Белый материал: цвет союзника задаётся через instanceColor, который three
      // умножает на цвет материала. С бежевым материалом вспышка не смогла бы
      // стать краснее его — умножение только гасит.
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 }),
      Squad.visibleAllyCapacity,
    );
    this.allyMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.allyMesh.frustumCulled = false;
    this.allyMesh.count = 0;
    scene.add(this.allyMesh);
  }

  /** Сколько доп. стрелков влезает в визуальный потолок: сумма rowSizes = 22. */
  static get visibleAllyCapacity(): number {
    let total = 0;
    for (const size of CONFIG.formation.rowSizes) total += size;
    return total;
  }

  /** Предел хода отряда в units от центра дороги. */
  static get limitX(): number {
    return (CONFIG.world.roadWidth / 2) * (CONFIG.player.travelLimitPercent / 100);
  }

  get positionPercent(): number {
    return this.percent;
  }

  /** Позиция отряда по x в мировых units. */
  get x(): number {
    return ((this.percent - 50) / 50) * Squad.limitX;
  }

  /** Всего стрелков, включая героя и «невидимых». */
  get shooterCount(): number {
    return 1 + this.allies.length;
  }

  get allyCount(): number {
    return this.allies.length;
  }

  get visibleAllyCount(): number {
    return Math.min(this.allies.length, Squad.visibleAllyCapacity);
  }

  get hiddenAllyCount(): number {
    return Math.max(0, this.allies.length - Squad.visibleAllyCapacity);
  }

  get weaponId(): WeaponId {
    return this.commonWeapon;
  }

  get isAlive(): boolean {
    return this.heroHp > 0;
  }

  /**
   * Глубина строя по z: до какого места тянутся видимые бойцы. Нужна воротам
   * типа B — турникет «проходят», пока он идёт от линии героя до последнего ряда.
   */
  get formationDepth(): number {
    if (this.allies.length === 0) return 0;
    this.allyOffset(this.visibleAllyCount - 1);
    return this.offsetZ;
  }

  /**
   * Есть ли хоть один стрелок в полосе [xMin, xMax] (ворота типа B: прибавку
   * применяет ЛЮБОЙ прошедший стрелок, не только герой).
   *
   * «Невидимые» бойцы не учитываются: у них нет своего места в строю, они стоят
   * за последним видимым рядом и физически через турникет не проходят.
   */
  hasShooterInRange(xMin: number, xMax: number): boolean {
    const squadX = this.x;
    if (squadX >= xMin && squadX <= xMax) return true;

    const visible = this.visibleAllyCount;
    for (let i = 0; i < visible; i++) {
      this.allyOffset(i);
      const allyX = squadX + this.offsetX;
      if (allyX >= xMin && allyX <= xMax) return true;
    }

    return false;
  }

  /**
   * Возвращает отряд в стартовое состояние нового забега: один герой в центре,
   * полное HP, стартовое оружие, наведение сброшено.
   *
   * Стартовое число бойцов прокачкой не меняется — выбранный состав улучшений
   * не затрагивает генерацию и состав забега.
   */
  reset(): void {
    this.allies.length = 0;
    this.heroHp = CONFIG.player.heroHp;
    this.commonWeapon = CONFIG.player.startWeapon as WeaponId;
    this.heroWeapon.setWeapon(this.commonWeapon);
    this.percent = 50;
    this.aimX = null;
    this.aimZ = null;
    this.heroHpBarLeft = 0;
    this.heroFlashLeft = 0;
    this.heroMaterial.color.copy(this.heroColor);
    this.allyMesh.count = 0;
    this.allyMesh.instanceMatrix.needsUpdate = true;
    this.heroMesh.position.x = 0;
  }

  /** Двигает отряд за вводом, раскладывает строй и стреляет. */
  update(dt: number, targetPercent: number): void {
    this.percent += (targetPercent - this.percent) * CONFIG.player.followLerp;

    // Таймеры полосок и вспышек тают по игровому dt: на экранах результата и
    // прокачки игровой шаг не идёт, поэтому там они не гаснут.
    if (this.heroHpBarLeft > 0) this.heroHpBarLeft -= dt;
    if (this.heroFlashLeft > 0) this.heroFlashLeft -= dt;
    for (const ally of this.allies) {
      if (ally.hpBarLeft > 0) ally.hpBarLeft -= dt;
      if (ally.flashLeft > 0) ally.flashLeft -= dt;
    }

    this.regenerate(dt);

    const squadX = this.x;
    this.heroMesh.position.x = squadX;
    // Герой — обычный меш, поэтому вспышка у него через цвет материала.
    this.heroMaterial.color.copy(this.heroFlashLeft > 0 ? this.heroFlash : this.heroColor);

    this.layoutAllies(squadX);
    this.fire(dt, squadX);
  }

  /**
   * Автоматическое восстановление HP стрелков (CONFIG.player.regen).
   *
   * Идёт ДО урона этого шага (зомби бьют в enemies.update, то есть после
   * squad.update), поэтому добить героя удар может и в тот же шаг, в который
   * прошло начисление: лечение не отменяет урон, а только опережает его.
   *
   * Полоску HP регенерация не зажигает намеренно: полоска по ТЗ — отметка
   * «получил урон», а от непрерывного лечения она висела бы над каждым задетым
   * бойцом до конца забега. Пока полоска показана после урона, рост на ней виден.
   */
  private regenerate(dt: number): void {
    const { regen, heroHp, allyHp } = CONFIG.player;
    if (regen.intervalSeconds <= 0 || regen.hpPerInterval <= 0) return;

    const gain = (regen.hpPerInterval / regen.intervalSeconds) * dt;

    // Мёртвый герой не отыгрывается: забег закончится в этот же шаг.
    if (this.heroHp > 0) this.heroHp = Math.min(heroHp, this.heroHp + gain);

    for (const ally of this.allies) {
      ally.hp = Math.min(allyHp, ally.hp + gain);
    }
  }

  // --- Строй ---------------------------------------------------------------

  private layoutAllies(squadX: number): void {
    const { allyCapsule } = CONFIG.player;
    const y = allyCapsule.length / 2 + allyCapsule.radius;
    const visible = this.visibleAllyCount;

    for (let i = 0; i < visible; i++) {
      this.allyOffset(i);
      this.matrix.makeTranslation(squadX + this.offsetX, y, this.offsetZ);
      this.allyMesh.setMatrixAt(i, this.matrix);
      // Индекс в меше равен индексу в строю, поэтому вспышку можно писать здесь же.
      const flashing = (this.allies[i]?.flashLeft ?? 0) > 0;
      this.allyMesh.setColorAt(i, flashing ? this.allyFlash : this.allyColor);
    }

    this.allyMesh.count = visible;
    this.allyMesh.instanceMatrix.needsUpdate = true;
    if (this.allyMesh.instanceColor !== null) this.allyMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Смещение бойца index относительно отряда — пишет в offsetX / offsetZ.
   *
   * Ряды берутся из CONFIG.formation.rowSizes (герой стоит в первом ряду один).
   * Бойцы за визуальным потолком получают координату последнего видимого места —
   * оттуда вылетают их пули.
   *
   * ШАХМАТКА. Ряд центрируется по своей НОМИНАЛЬНОЙ ширине, а не по числу уже
   * пришедших бойцов: только тогда чётные ряды дают полуцелые смещения, нечётные
   * целые, и решётка не разъезжается при неполном ряде. Чтобы неполный ряд при
   * этом всё равно выглядел центрированным, места занимаются ОТ СЕРЕДИНЫ НАРУЖУ:
   * 0, +1, −1, +2, −2 для нечётного ряда и +0.5, −0.5, +1.5, −1.5 для чётного.
   * Прежняя раскладка центрировала ряд по факту и заполняла слева направо —
   * неполный ряд ехал в сторону, а места попадали в затылок предыдущему ряду.
   */
  private allyOffset(index: number): void {
    const { rowSizes, spacingX, spacingZ } = CONFIG.formation;
    const capped = Math.min(index, Squad.visibleAllyCapacity - 1);

    // Ищем ряд перебором: рядов единицы, массив короткий.
    let row = 0;
    let posInRow = capped;
    while (row < rowSizes.length - 1 && posInRow >= rowSizes[row]!) {
      posInRow -= rowSizes[row]!;
      row++;
    }

    const nominal = rowSizes[row]!;
    // Смещение от центра ряда в шагах spacingX. Чётный ряд начинается с ±0.5,
    // нечётный — с 0; отсюда и берётся полушаговый сдвиг соседних рядов.
    const even = nominal % 2 === 0;
    const step = even ? Math.floor(posInRow / 2) + 0.5 : Math.ceil(posInRow / 2);
    const positive = even ? posInRow % 2 === 0 : posInRow % 2 === 1;

    this.offsetX = (positive ? step : -step) * spacingX;
    // Ряды уходят назад: герой в z = 0, первый ряд союзников за ним.
    this.offsetZ = (row + 1) * spacingZ;
  }

  // --- Стрельба ------------------------------------------------------------

  /**
   * Перенаправляет огонь отряда на точку (боссфайт). Без цели стрелки бьют вперёд.
   */
  setAimTarget(x: number | null, z: number | null): void {
    this.aimX = x;
    this.aimZ = z;
  }

  private fire(dt: number, squadX: number): void {
    const aimX = this.aimX ?? undefined;
    const aimZ = this.aimZ ?? undefined;

    const heroShots = this.heroWeapon.tick(dt);
    if (heroShots > 0) {
      const heroWeapon = this.heroWeapon.weaponId;
      // Урон и дальность — через аксессоры: они учитывают мета-прокачку.
      const damage = weaponDamage(heroWeapon);
      const range = weaponRange(heroWeapon);
      for (let shot = 0; shot < heroShots; shot++) {
        this.bullets.spawn(squadX, 0, damage, range, heroWeapon, aimX, aimZ);
      }
    }

    const visibleCapacity = Squad.visibleAllyCapacity;
    const hiddenMultiplier = CONFIG.formation.bulletsPerHiddenShooter;

    for (let i = 0; i < this.allies.length; i++) {
      const ally = this.allies[i]!;
      const shots = ally.weapon.tick(dt);
      if (shots === 0) continue;

      const allyWeapon = ally.weapon.weaponId;
      const damage = weaponDamage(allyWeapon);
      const range = weaponRange(allyWeapon);
      this.allyOffset(i);
      // Невидимые бойцы стреляют из последнего видимого ряда и по множителю из
      // конфига — это и есть «плотность огня растёт за потолком».
      const perShot = i < visibleCapacity ? 1 : hiddenMultiplier;

      for (let shot = 0; shot < shots * perShot; shot++) {
        this.bullets.spawn(
          squadX + this.offsetX,
          this.offsetZ,
          damage,
          range,
          allyWeapon,
          aimX,
          aimZ,
        );
      }
    }
  }

  // --- Урон ----------------------------------------------------------------

  /**
   * Удар зомби (ТЗ раздел 5: «бьют ближайшего стрелка»).
   *
   * ОГРАНИЧЕНИЯ ПО РАССТОЯНИЮ НЕТ. Раньше был параметр reachX (1.5 units по
   * горизонтали), и зомби у правого края дороги не достигал отряда у левого.
   * Теперь удар всегда находит ближайшего стрелка: расстояние считается по обеим
   * осям от (fromX, fromZ), поэтому первым получает передний ряд, а не случайный
   * боец. Следствие для игры — уводом отряда поперёк дороги урон дошедшей толпы
   * больше не обнуляется.
   *
   * ГЛАВНЫЙ ГЕРОЙ — ЦЕЛЬ ТОЛЬКО КОГДА ОН ОДИН. Пока в отряде есть хоть один
   * союзник, удары достаются союзникам, а герой неуязвим для зомби. Без reachX
   * это правило стало безусловным: союзник в переборе есть всегда, когда он есть
   * в строю, — прежней лазейки «все союзники вне полосы, значит удар в никуда»
   * не осталось.
   *
   * Раньше герой получал вообще весь урон от зомби: союзники стоят позади него
   * по +Z, поэтому ближайшим к нападающему всегда оказывался он (замерено: 8.2
   * удара по герою за прогон против ровно нуля по союзникам).
   *
   * Бойцы за визуальным потолком недосягаемы: они позади всего строя.
   */
  damageNearestShooter(fromX: number, fromZ: number, amount: number): boolean {
    const incoming = amount * CONFIG.player.damageTakenMultiplier;
    const squadX = this.x;

    let bestIndex = -2; // -2 — никого, -1 — герой, >= 0 — индекс союзника
    let bestDistanceSq = Infinity;

    const heroDx = squadX - fromX;
    if (this.allies.length === 0) {
      const heroDz = 0 - fromZ;
      bestIndex = -1;
      bestDistanceSq = heroDx * heroDx + heroDz * heroDz;
    }

    const visible = this.visibleAllyCount;
    for (let i = 0; i < visible; i++) {
      this.allyOffset(i);
      const dx = squadX + this.offsetX - fromX;
      const dz = this.offsetZ - fromZ;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestIndex = i;
      }
    }

    if (bestIndex === -2) return false;

    if (bestIndex === -1) {
      this.hurtHero(incoming);
      return true;
    }

    this.hurtAlly(bestIndex, incoming);
    return true;
  }

  /**
   * AoE босса: урон всем стрелкам внутри круга (ТЗ раздел 10).
   *
   * Именно здесь работает уклонение: круг задан заранее телеграфом, и если отряд
   * успел уйти, попавших не окажется. Возвращает число задетых стрелков.
   */
  damageShootersInCircle(x: number, z: number, radius: number, damage: number): number {
    const incoming = damage * CONFIG.player.damageTakenMultiplier;
    const radiusSq = radius * radius;
    const squadX = this.x;
    let hit = 0;

    const heroDx = squadX - x;
    const heroDz = 0 - z;
    if (heroDx * heroDx + heroDz * heroDz <= radiusSq) {
      this.hurtHero(incoming);
      hit++;
    }

    // Идём с конца: погибший боец удаляется splice'ом, и обход не сбивается.
    const visible = this.visibleAllyCount;
    for (let i = visible - 1; i >= 0; i--) {
      this.allyOffset(i);
      const dx = squadX + this.offsetX - x;
      const dz = this.offsetZ - z;
      if (dx * dx + dz * dz > radiusSq) continue;

      hit++;
      this.hurtAlly(i, incoming);
    }

    return hit;
  }

  /**
   * Наезд бочки: урон всем стрелкам в вертикальной полосе шириной хитбокса бочки.
   *
   * Полоса идёт по всей глубине строя, а не только по первому ряду: катящаяся
   * бочка проходит сквозь колонну целиком, поэтому по z ничего не проверяется —
   * только по x. Уворот остаётся: увёл отряд из полосы — не задело никого.
   *
   * «Невидимые» бойцы за визуальным потолком не задеваются, как и в остальных
   * источниках урона: их позиции не раскладываются, и полосы у них нет.
   *
   * Возвращает число задетых стрелков.
   */
  damageShootersInBand(centerX: number, halfWidth: number, damage: number): number {
    const incoming = damage * CONFIG.player.damageTakenMultiplier;
    const squadX = this.x;
    let hit = 0;

    if (Math.abs(squadX - centerX) <= halfWidth) {
      this.hurtHero(incoming);
      hit++;
    }

    // Идём с конца: погибший боец удаляется splice'ом, и обход не сбивается.
    const visible = this.visibleAllyCount;
    for (let i = visible - 1; i >= 0; i--) {
      this.allyOffset(i);
      if (Math.abs(squadX + this.offsetX - centerX) > halfWidth) continue;

      hit++;
      this.hurtAlly(i, incoming);
    }

    return hit;
  }

  /**
   * Неуклоняемый удар босса по всем сразу (ТЗ раздел 10).
   *
   * Задевает и бойцов за визуальным потолком, в отличие от удара зомби: у зомби
   * есть досягаемость по горизонтали, а эта атака по ТЗ бьёт всех и уклониться
   * от неё нельзя. Возвращает число задетых стрелков.
   */
  damageAllShooters(damage: number): number {
    const incoming = damage * CONFIG.player.damageTakenMultiplier;
    let hit = 1;
    this.hurtHero(incoming);

    for (let i = this.allies.length - 1; i >= 0; i--) {
      hit++;
      this.hurtAlly(i, incoming);
    }

    return hit;
  }

  /*
   * Ниже — ДВЕ ЕДИНСТВЕННЫЕ точки, где стрелок теряет HP.
   *
   * До этого присвоение было раскидано по шести местам трёх методов урона, и
   * требование «полоска показывается после изменения значения» невозможно было
   * выполнить надёжно: одну точку рано или поздно пропустишь. Теперь таймер
   * полоски ставится здесь и попадает во все источники урона сразу.
   */

  private hurtHero(incoming: number): void {
    this.heroHp = Math.max(0, this.heroHp - incoming);
    this.heroHpBarLeft = CONFIG.ui.hpBar.showSeconds;
    this.heroFlashLeft = CONFIG.ui.damageFlash.seconds;
  }

  /** Наносит урон союзнику index; выбитый покидает строй. */
  private hurtAlly(index: number, incoming: number): void {
    const ally = this.allies[index];
    if (ally === undefined) return;

    ally.hp -= incoming;
    ally.hpBarLeft = CONFIG.ui.hpBar.showSeconds;
    ally.flashLeft = CONFIG.ui.damageFlash.seconds;

    if (ally.hp <= 0) {
      // Выбитый боец покидает строй. Массив = строй, поэтому сдвиг сам подтягивает
      // «невидимого» бойца на освободившееся место в видимой части.
      this.allies.splice(index, 1);
    }
  }

  // --- Бонусы из бочек ------------------------------------------------------

  /**
   * Бонус «стрелки»: добавляет доп. стрелков с общим оружием отряда.
   *
   * Обрезается по CONFIG.formation.maxShooters — это ЕДИНСТВЕННАЯ точка входа
   * бойцов в отряд (бочки и обе стены ворот зовут её же), поэтому предел стоит
   * здесь, а не в каждом источнике. Бонус сверх предела теряется молча.
   */
  addShooters(count: number): void {
    const free = CONFIG.formation.maxShooters - this.shooterCount;
    const added = Math.max(0, Math.min(count, free));

    for (let i = 0; i < added; i++) {
      this.allies.push({
        hp: CONFIG.player.allyHp,
        // Случайная фаза: одинаковые накопители у всех дали бы залпы вместо потока.
        weapon: new WeaponState(this.commonWeapon, Math.random()),
        // Новый боец урона не получал — ни полоски, ни вспышки у него быть не должно.
        hpBarLeft: 0,
        flashLeft: 0,
      });
    }
  }

  /** Убирает доп. стрелков (отрицательная секция ворот, слой 6). Героя не трогает. */
  removeShooters(count: number): number {
    const removed = Math.min(count, this.allies.length);
    this.allies.length -= removed;
    return removed;
  }

  /**
   * Бонус «оружие»: стрелковое оружие поднимается на ступень у ВСЕГО отряда
   * (ТЗ раздел 6). Возвращает новое оружие или null, если ступень последняя.
   *
   * Бойцов с ОСОБЫМ оружием пропускает: по ТЗ особое заменяет ствол полностью,
   * и подобранный из бочки автомат не должен его затирать. Общее оружие отряда
   * при этом всё равно поднимается — новые бойцы получат уже новую ступень.
   */
  upgradeSquadWeapon(): WeaponId | null {
    const chain = CONFIG.weapons.progression as WeaponId[];
    const current = chain.indexOf(this.commonWeapon);
    if (current < 0 || current >= chain.length - 1) return null;

    const next = chain[current + 1]!;
    this.commonWeapon = next;

    if (!isSpecialWeapon(this.heroWeapon.weaponId)) this.heroWeapon.setWeapon(next);
    for (const ally of this.allies) {
      if (!isSpecialWeapon(ally.weapon.weaponId)) ally.weapon.setWeapon(next);
    }

    return next;
  }

  /**
   * Бонус «особое оружие» (ТЗ раздел 6): заменяет ствол у ОДНОГО бойца.
   *
   * Порядок выдачи по ТЗ: сначала главный герой, затем доп. стрелки в случайном
   * порядке. Кандидат выбирается резервуарной выборкой — один проход и без
   * промежуточного массива, зато распределение равномерное.
   *
   * Если особое есть уже у всех, ствол достаётся случайному доп. стрелку: иначе
   * разбитая бочка не дала бы ничего.
   *
   * Возвращает, кому досталось.
   */
  giveSpecialWeapon(id: WeaponId): 'hero' | 'ally' {
    if (!isSpecialWeapon(this.heroWeapon.weaponId)) {
      this.heroWeapon.setWeapon(id);
      return 'hero';
    }

    let chosen = -1;
    let seen = 0;
    for (let i = 0; i < this.allies.length; i++) {
      if (isSpecialWeapon(this.allies[i]!.weapon.weaponId)) continue;
      seen++;
      if (Math.random() * seen < 1) chosen = i;
    }

    if (chosen < 0 && this.allies.length > 0) {
      chosen = Math.floor(Math.random() * this.allies.length);
    }

    if (chosen >= 0) {
      this.allies[chosen]!.weapon.setWeapon(id);
      return 'ally';
    }

    // Отряд — один герой, и особое у него уже есть: меняем на новое.
    this.heroWeapon.setWeapon(id);
    return 'hero';
  }

  /**
   * Бонус «мина» из бочки (ТЗ раздел 7): отряд расставляет мины перед собой.
   * Позицию берём текущую — мины ложатся в ту полосу, где отряд сейчас стоит.
   */
  deployMines(count?: number): void {
    this.mines.place(this.x, count);
  }

  /**
   * Перечисляет полоски HP: герой и видимые союзники, получавшие урон в последние
   * ui.hpBar.showSeconds секунд.
   *
   * Бойцы за визуальным потолком пропущены: у них нет своего места в строю, рисовать
   * полоску не над чем.
   */
  forEachHpBar(visit: (x: number, y: number, z: number, fraction: number) => void): void {
    const { heroCapsule, allyCapsule, heroHp, allyHp } = CONFIG.player;
    const offsetY = CONFIG.ui.hpBar.offsetY;
    const squadX = this.x;

    if (this.heroHpBarLeft > 0) {
      const top = heroCapsule.length + heroCapsule.radius * 2;
      visit(squadX, top + offsetY, 0, this.heroHp / heroHp);
    }

    const allyTop = allyCapsule.length + allyCapsule.radius * 2;
    const visible = this.visibleAllyCount;
    for (let i = 0; i < visible; i++) {
      const ally = this.allies[i]!;
      if (ally.hpBarLeft <= 0) continue;

      this.allyOffset(i);
      visit(squadX + this.offsetX, allyTop + offsetY, this.offsetZ, ally.hp / allyHp);
    }
  }

  /** Сколько полосок HP сейчас показано — для отладки и проверок. */
  get hpBarsVisible(): number {
    let total = this.heroHpBarLeft > 0 ? 1 : 0;
    const visible = this.visibleAllyCount;
    for (let i = 0; i < visible; i++) {
      if (this.allies[i]!.hpBarLeft > 0) total++;
    }
    return total;
  }

  /** Сколько бойцов держат особое оружие — для HUD и проверок. */
  get specialWeaponCount(): number {
    let total = isSpecialWeapon(this.heroWeapon.weaponId) ? 1 : 0;
    for (const ally of this.allies) {
      if (isSpecialWeapon(ally.weapon.weaponId)) total++;
    }
    return total;
  }

  /** Состояние отряда — для отладки и проверок. */
  debugSnapshot(): {
    x: number;
    heroHp: number;
    weapon: WeaponId;
    visible: number;
    hidden: number;
    heroWeapon: WeaponId;
    specials: number;
    allies: Array<{
      index: number;
      hp: number;
      x: number;
      z: number;
      visible: boolean;
      weapon: WeaponId;
      special: boolean;
      hpBarLeft: number;
    }>;
    heroHpBarLeft: number;
  } {
    const squadX = this.x;
    const allies = this.allies.map((ally, index) => {
      this.allyOffset(index);
      return {
        index,
        hp: ally.hp,
        x: +(squadX + this.offsetX).toFixed(3),
        z: +this.offsetZ.toFixed(3),
        visible: index < Squad.visibleAllyCapacity,
        weapon: ally.weapon.weaponId,
        special: isSpecialWeapon(ally.weapon.weaponId),
        hpBarLeft: +ally.hpBarLeft.toFixed(3),
      };
    });

    return {
      x: squadX,
      heroHp: this.heroHp,
      weapon: this.commonWeapon,
      heroWeapon: this.heroWeapon.weaponId,
      specials: this.specialWeaponCount,
      visible: this.visibleAllyCount,
      hidden: this.hiddenAllyCount,
      allies,
      heroHpBarLeft: +this.heroHpBarLeft.toFixed(3),
    };
  }
}
