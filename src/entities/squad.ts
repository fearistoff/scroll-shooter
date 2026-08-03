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
import { cubicBezierEase } from '../core/easing';
import type { BonusReceiver } from './barrels';
import type { BossTarget } from './boss';
import type { BulletPool } from './bullets';
import type { SquadTarget } from './enemies';
import { FallPose } from './fall';
import { makeCorpseColor, makeFlashColor } from './flash';
import type { GateTarget } from './gates';
import type { MineField } from './mines';
import {
  isSpecialWeapon,
  specialWeaponRank,
  weaponBlastDamage,
  weaponDamage,
  weaponRange,
  WeaponState,
  type WeaponId,
} from './weapons';

/**
 * Магазин со стороны отряда: какие стволы открыты доп. стрелкам
 * (MetaProgress реализует). Узкий интерфейс у потребителя, как SquadTarget и
 * прочие: entities не зависят от core.
 */
export interface AllyWeaponAccess {
  isAllyWeaponUnlocked(id: WeaponId): boolean;
}

/** Доп. стрелок. Главный герой хранится отдельно — он не взаимозаменяем. */
interface Ally {
  hp: number;
  weapon: WeaponState;
  /** Сколько секунд регенерация ещё запрещена. Ставится при уроне. */
  regenDelayLeft: number;
  /** Остаток вспышки от урона (ui.damageFlash). Ставится там же. */
  flashLeft: number;
  /**
   * Остаток анимации появления (player.spawnAnim), секунды. Ставится в
   * addShooters — единственной точке входа бойцов в отряд. Пока тает, капсула
   * вырастает от подошвы; на игровые проверки не влияет.
   */
  spawnLeft: number;
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
  heroHp = CONFIG.player.heroHp * CONFIG.player.heroMultipliers.hpMultiplier;

  /** Оружие главного героя. */
  readonly heroWeapon: WeaponState;

  /**
   * Арендованные в кит стволы этого забега: аренда обходит замки магазина,
   * включая доступ стрелков (allyMayHold), — оплаченный на забег ствол держат
   * все. Наполняет equipStartWeapon, чистит reset. Стволов максимум два —
   * стрелковый и особый.
   */
  private readonly rentedWeapons: WeaponId[] = [];

  /** Сколько секунд регенерация героя ещё запрещена (player.regen). */
  private heroRegenDelayLeft = 0;
  /** Остаток вспышки героя от урона (ui.damageFlash). */
  private heroFlashLeft = 0;

  /**
   * Фаза мигания полосок лечащихся стрелков (ui.hpBar.healPulse), секунды от
   * начала цикла. Одна на весь отряд — см. конфиг. Идёт всегда, а не только
   * когда кто-то лечится: включать её по событию незачем, читают её только те
   * полоски, у которых лечение уже пошло.
   */
  private healPulseTime = 0;

  /**
   * Остаток падения героя, секунды. Ставится в startHeroDeath и убывает только в
   * updateHeroDeath: обычный update в это время уже не зовут — отряд не ходит.
   */
  private heroDeathLeft = 0;
  /** Азимут падения героя, радианы: 0 — на +X, π/2 — на +Z. Любой из 360°. */
  private heroDeathYaw = 0;
  /**
   * Где герой стоял в момент смерти. Запоминается отдельно, потому что подошва
   * при падении не двигается, а центр капсулы от неё уезжает — и обычный update,
   * который каждый кадр возвращал бы heroMesh.position.x к позиции отряда, в фазе
   * прощания уже не зовут.
   */
  private heroDeathX = 0;
  /** Поза падения героя. Общая формула с телами зомби и босса (FallPose). */
  private readonly heroFallPose = new FallPose();

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
  /** Цвет мёртвого героя — тёмный оттенок своего, как у тел зомби. */
  private readonly heroCorpseColor = makeCorpseColor(CONFIG.player.colors.hero);
  private readonly allyFlash = makeFlashColor(CONFIG.player.colors.ally);

  /** Общее стрелковое оружие отряда (ТЗ раздел 6: подобрал — у всех). */
  private commonWeapon: WeaponId;

  private percent = 50;

  /**
   * Фактический предел хода, units от центра дороги. Живое число: оно зависит от
   * ширины строя (limitXTarget) и потому меняется прямо в забеге — не мгновенно,
   * а с ограниченной скоростью (см. easeLimit). Ставится в конструкторе и в reset.
   */
  private limitXCurrent = 0;

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
    private readonly allyAccess: AllyWeaponAccess,
  ) {
    const { heroCapsule, allyCapsule, colors, startWeapon } = CONFIG.player;

    this.commonWeapon = startWeapon as WeaponId;
    this.heroWeapon = new WeaponState(this.commonWeapon, 'hero');

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
    this.heroMesh.position.set(0, Squad.heroStandY, 0);
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

    // Предел хода читают снаружи (Squad.x) и до первого шага логики, поэтому он
    // не может остаться нулём до первого easeLimit.
    this.limitXCurrent = this.limitXTarget;
  }

  /** Сколько доп. стрелков влезает в визуальный потолок: сумма rowSizes = 22. */
  static get visibleAllyCapacity(): number {
    let total = 0;
    for (const size of CONFIG.formation.rowSizes) total += size;
    return total;
  }

  /**
   * Насколько отряд торчит вбок от своего центра: до КРОМКИ крайней капсулы, а не
   * до её центра. У одного героя это его радиус, дальше растёт по строю.
   *
   * Считается по рядам, а не перебором бойцов: места в ряду занимаются от
   * середины наружу (см. allyOffset), поэтому дальше всех в ряду стоит последний
   * пришедший, и хватает одного шага на ряд. Максимум берётся по всем занятым
   * рядам, потому что широкий ряд может быть ещё не заполнен: при 11 союзниках
   * крайний стоит в ряду из пяти, а не в начатом ряду из шести.
   */
  get halfWidth(): number {
    const heroHalf = CONFIG.player.heroCapsule.radius;
    const visible = this.visibleAllyCount;
    if (visible === 0) return heroHalf;

    const { rowSizes, spacingX } = CONFIG.formation;
    let left = visible;
    let widestStep = 0;

    for (const nominal of rowSizes) {
      if (left <= 0) break;
      const inRow = Math.min(left, nominal);
      left -= inRow;
      widestStep = Math.max(widestStep, Squad.rowStep(inRow - 1, nominal));
    }

    return Math.max(heroHalf, widestStep * spacingX + CONFIG.player.allyCapsule.radius);
  }

  /** Предел хода отряда в units от центра дороги. */
  get limitX(): number {
    return this.limitXCurrent;
  }

  /**
   * Куда предел хода едет при нынешней ширине строя.
   *
   * travelLimitPercent задаёт предел ОДИНОЧНОГО ГЕРОЯ, и от него берётся линия,
   * до которой отряду позволено подходить кромкой: heroLimit + радиус героя.
   * Дальше вычитается фактическая полуширина строя — поэтому крайняя капсула
   * всегда встаёт на одно и то же место у кромки асфальта, сколько бы бойцов в
   * отряде ни было (ЗАМЕРЕНО: 4.86 units и у одинокого героя, и у полного отряда
   * из 23). Раньше предел был один на любой размер, и полный отряд у кромки
   * выносил на обочину 10 капсул из 22 — крайняя стояла центром в 6.66.
   *
   * Нижняя граница 0 — на случай строя шире дороги (rowSizes раздули так, что
   * ряд не влезает): отряд просто встаёт по центру и вбок не ходит.
   */
  private get limitXTarget(): number {
    const roadHalf = CONFIG.world.roadWidth / 2;
    const heroLimit = roadHalf * (CONFIG.player.travelLimitPercent / 100);
    return Math.max(0, heroLimit + CONFIG.player.heroCapsule.radius - this.halfWidth);
  }

  get positionPercent(): number {
    return this.percent;
  }

  /** Позиция отряда по x в мировых units. */
  get x(): number {
    return ((this.percent - 50) / 50) * this.limitX;
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
   * Полный запас HP с учётом прокачки (ветки heroHp/allyHp пишут hpMultiplier).
   * Считается от конфига каждый раз, а не снимком: множитель применяется на
   * старте забега (applyTo → reset), и запомненное значение пережило бы покупку.
   * ЕДИНСТВЕННЫЕ точки, где база из конфига умножается, — все потолки лечения,
   * полоски и стартовые HP спрашивают их, иначе полоска и лечение разошлись бы.
   */
  private get heroMaxHp(): number {
    return CONFIG.player.heroHp * CONFIG.player.heroMultipliers.hpMultiplier;
  }

  /** Полный запас HP доп. стрелка — см. heroMaxHp. */
  private get allyMaxHp(): number {
    return CONFIG.player.allyHp * CONFIG.player.allyMultipliers.hpMultiplier;
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
    this.heroHp = this.heroMaxHp;
    this.rentedWeapons.length = 0;
    this.commonWeapon = CONFIG.player.startWeapon as WeaponId;
    this.heroWeapon.setWeapon(this.commonWeapon);
    this.percent = 50;
    // Отряд снова из одного героя — предел сразу полный, без наезда easeLimit:
    // забег не должен начинаться с ползущей вбок границы прошлого состава.
    this.snapTravelLimit();
    this.aimX = null;
    this.aimZ = null;
    this.heroRegenDelayLeft = 0;
    this.heroFlashLeft = 0;
    this.healPulseTime = 0;
    this.heroMaterial.color.copy(this.heroColor);
    this.allyMesh.count = 0;
    this.allyMesh.instanceMatrix.needsUpdate = true;
    this.heroMesh.position.x = 0;
    // Герой прошлого забега остался лежать: меш один на всю игру, и без явного
    // подъёма новый забег начался бы с капсулы на боку.
    this.heroDeathLeft = 0;
    this.heroDeathYaw = 0;
    this.heroDeathX = 0;
    this.heroMesh.quaternion.identity();
    this.heroMesh.position.y = Squad.heroStandY;
    // z тоже: упасть герой мог и вдоль дороги, а стоит он всегда в z = 0.
    this.heroMesh.position.z = 0;
  }

  /**
   * Ставит предел хода ровно по нынешней ширине строя, без наезда easeLimit.
   * Нужен старту забега: бойцы из оплаченного кита приходят ПОСЛЕ reset, и без
   * этого забег начинался бы с границей от одиночного героя, которая первые
   * полсекунды сползала бы к своему месту.
   */
  snapTravelLimit(): void {
    this.limitXCurrent = this.limitXTarget;
  }

  /** Высота центра стоящей капсулы героя: подошвы на дороге, y = 0. */
  private static get heroStandY(): number {
    const { heroCapsule } = CONFIG.player;
    return heroCapsule.length / 2 + heroCapsule.radius;
  }

  /**
   * Начинает падение героя. Зовётся из Game в момент, когда его HP дошло до нуля:
   * забег там же переходит в фазу прощания, и с этого шага отряд больше не ходит
   * и не стреляет — двигается только эта капсула.
   */
  startHeroDeath(): void {
    this.heroDeathLeft = CONFIG.deathAnim.fallSeconds;
    this.heroDeathYaw = Math.random() * Math.PI * 2;
    this.heroDeathX = this.x;
    // Цвет ставится здесь и держится до конца забега: в фазе прощания update не
    // зовут, и вернуть его на живой (как это делает строка вспышки) уже некому.
    // Обратно материал переводит reset при старте следующего забега.
    this.heroMaterial.color.copy(this.heroCorpseColor);
    this.applyHeroFall();
  }

  /**
   * Шаг падения героя. Отдельный метод, а не часть update: в фазе прощания
   * игровой шаг не идёт вовсе — ни ввода, ни стрельбы, ни регенерации.
   */
  updateHeroDeath(dt: number): void {
    if (this.heroDeathLeft > 0) this.heroDeathLeft = Math.max(0, this.heroDeathLeft - dt);
    this.applyHeroFall();
  }

  /** Идёт ли ещё падение героя — для отладки и проверок. */
  get heroFalling(): boolean {
    return this.heroDeathLeft > 0;
  }

  /**
   * Поза падения по остатку таймера. Считает FallPose — та же формула, что у тел
   * зомби и босса: ось поворота у ПОДОШВЫ, точки (heroDeathX, radius, 0). Она
   * стоит на месте, а центр капсулы едет по дуге вокруг неё, и валиться герой
   * может в любую сторону из 360° — значит, двигаются все три координаты.
   */
  private applyHeroFall(): void {
    const pose = this.heroFallPose.set(
      this.heroDeathX,
      0,
      this.heroDeathYaw,
      this.heroDeathLeft,
      CONFIG.player.heroCapsule,
    );

    this.heroMesh.quaternion.setFromAxisAngle(pose.axis, pose.angle);
    this.heroMesh.position.set(pose.x, pose.y, pose.z);
  }

  /** Двигает отряд за вводом, раскладывает строй и стреляет. */
  update(dt: number, targetPercent: number): void {
    // Первым делом: положение отряда считается от предела, и позади по шагу идут
    // стрельба и раскладка строя — они должны видеть уже новое значение.
    this.easeLimit(dt);
    this.percent += (targetPercent - this.percent) * CONFIG.player.followLerp;

    // Таймеры вспышек и паузы регенерации тают по игровому dt: на экранах
    // результата и прокачки игровой шаг не идёт, поэтому там они не тают.
    if (this.heroRegenDelayLeft > 0) this.heroRegenDelayLeft -= dt;
    if (this.heroFlashLeft > 0) this.heroFlashLeft -= dt;
    for (const ally of this.allies) {
      if (ally.regenDelayLeft > 0) ally.regenDelayLeft -= dt;
      if (ally.flashLeft > 0) ally.flashLeft -= dt;
      // Тает у ВСЕХ бойцов, включая тех, что за визуальным потолком: пришедший
      // «невидимым» отыгрывает рост, стоя за строем, и на освободившееся место
      // после гибели соседа встаёт уже в полный рост, а не вырастает заново.
      if (ally.spawnLeft > 0) ally.spawnLeft -= dt;
    }

    // Фаза мигания — тоже по игровому dt: на паузе и на экранах полоска замирает
    // в том состоянии, в котором её застали, а не мигает над стоящей игрой.
    const pulsePeriod = CONFIG.ui.hpBar.healPulse.periodSeconds;
    if (pulsePeriod > 0) this.healPulseTime = (this.healPulseTime + dt) % pulsePeriod;

    this.regenerate(dt);

    const squadX = this.x;
    this.heroMesh.position.x = squadX;
    // Герой — обычный меш, поэтому вспышка у него через цвет материала.
    this.heroMaterial.color.copy(this.heroFlashLeft > 0 ? this.heroFlash : this.heroColor);

    this.layoutAllies(squadX);
    this.fire(dt, squadX);
  }

  /**
   * Подводит предел хода к нынешней ширине строя — не скачком, а с постоянной
   * скоростью (player.travelLimitEaseSpeed).
   *
   * Скачок здесь заметен: бойцы приходят пачками (стена ворот, множитель у
   * турникета), и одно новое место в ряду расширяет строй сразу на spacingX =
   * 0.72, а пачка — и на больше (ЗАМЕРЕНО 1.02 units, когда трое приходят к
   * одинокому герою). Отряд, стоящий у самой кромки, при мгновенной смене предела
   * проехал бы всю эту величину за один кадр.
   *
   * Скорость в units/с, а не доля за шаг: dt в цикле не постоянный. ЗАМЕРЕНО, что
   * от dt не зависит: те же 1.02 units проходят за 0.267 с при 1/60 и 0.258 с при
   * 1/120 (разница — округление последнего шага).
   */
  private easeLimit(dt: number): void {
    const target = this.limitXTarget;
    const delta = target - this.limitXCurrent;
    const step = CONFIG.player.travelLimitEaseSpeed * dt;

    // Скорость ≤ 0 означает «мгновенно» — иначе предел не сдвинулся бы никогда.
    if (step <= 0 || Math.abs(delta) <= step) this.limitXCurrent = target;
    else this.limitXCurrent += Math.sign(delta) * step;
  }

  /**
   * Автоматическое восстановление HP стрелков (CONFIG.player.regen).
   *
   * Идёт ДО урона этого шага (зомби бьют в enemies.update, то есть после
   * squad.update), поэтому добить героя удар может и в тот же шаг, в который
   * прошло начисление: лечение не отменяет урон, а только опережает его.
   *
   * Пауза после урона (regen.delayAfterDamageSeconds) считается КАЖДОМУ стрелку
   * своя: союзника задело взрывом босса — лечится только он, остальные
   * продолжают. Таймер тает в update, здесь он только читается; ставится он в
   * воронках урона, потому что длина паузы зависит от ветки прокачки того, кому
   * достался удар (regenDelayMultiplier).
   *
   * СКОРОСТЬ ЛЕЧЕНИЯ ТОЖЕ РАЗНАЯ у героя и у союзников: базовое число одно
   * (CONFIG.player.regen), но каждая половина отряда домножает его на свой
   * regenRateMultiplier. Поэтому прибавка считается двумя числами, а не одним.
   *
   * Полоску HP регенерация не прячет и не зажигает: у стрелков полоска висит,
   * пока запас не полный, поэтому рост виден сам собой и гаснет она ровно в тот
   * момент, когда HP отыгралось. Пока отыгрыш идёт, полоска мигает
   * (ui.hpBar.healPulse) — условие мигания повторяет условие начисления ниже,
   * см. isRegenerating.
   */
  private regenerate(dt: number): void {
    const { regen, heroMultipliers, allyMultipliers } = CONFIG.player;
    if (regen.intervalSeconds <= 0 || regen.hpPerInterval <= 0) return;

    const gain = (regen.hpPerInterval / regen.intervalSeconds) * dt;

    // Мёртвый герой не отыгрывается: забег закончится в этот же шаг.
    if (this.heroHp > 0 && this.heroRegenDelayLeft <= 0) {
      this.heroHp = Math.min(
        this.heroMaxHp,
        this.heroHp + gain * heroMultipliers.regenRateMultiplier,
      );
    }

    const allyGain = gain * allyMultipliers.regenRateMultiplier;
    const allyMaxHp = this.allyMaxHp;
    for (const ally of this.allies) {
      if (ally.regenDelayLeft > 0) continue;
      ally.hp = Math.min(allyMaxHp, ally.hp + allyGain);
    }
  }

  /**
   * Идёт ли отыгрыш HP у бойца с таким остатком паузы. Условие ровно то же, что
   * в regenerate: полоска мигает тогда и только тогда, когда HP реально растёт.
   * Потолок здесь не проверяется — полоски у бойца с полным запасом всё равно нет.
   */
  private static isRegenerating(regenDelayLeft: number): boolean {
    const { regen } = CONFIG.player;
    if (regen.intervalSeconds <= 0 || regen.hpPerInterval <= 0) return false;
    return regenDelayLeft <= 0;
  }

  /**
   * Доля белого в заливке на этом кадре, 0…1 (ui.hpBar.healPulse): 0 — своя
   * красная, 1 — белая, между ними смесь.
   *
   * Косинус, а не пила: у обоих краёв производная нулевая, поэтому полоска
   * задерживается в чистом красном и в чистом белом, а перетекает между ними
   * быстро. Цикл начинается с красного — момент, когда лечение пошло, виден
   * как нарастание, а не как готовое белое пятно.
   */
  private get healPulseBrightness(): number {
    const period = CONFIG.ui.hpBar.healPulse.periodSeconds;
    if (period <= 0) return 0;
    return (1 - Math.cos((2 * Math.PI * this.healPulseTime) / period)) / 2;
  }

  // --- Строй ---------------------------------------------------------------

  private layoutAllies(squadX: number): void {
    const { allyCapsule } = CONFIG.player;
    const y = allyCapsule.length / 2 + allyCapsule.radius;
    const visible = this.visibleAllyCount;

    for (let i = 0; i < visible; i++) {
      this.allyOffset(i);
      // Рост от подошвы: масштаб равномерный, а центр капсулы поднимается вместе
      // с ним — при y = const боец вырастал бы из-под асфальта (см. spawnScale).
      const scale = Squad.spawnScale(this.allies[i]!.spawnLeft);
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(squadX + this.offsetX, y * scale, this.offsetZ);
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
   * Масштаб капсулы по остатку анимации появления (player.spawnAnim).
   *
   * Повторяет CSS-keyframes «0% scale(0) → 75% scale(1.1) → 100% scale(1)»
   * буквально, включая то, что умолчание timing-function (ease) в CSS
   * применяется к КАЖДОМУ участку отдельно: до пика кривая своя и после пика
   * своя, поэтому один общий easing по всей длине дал бы другое движение.
   *
   * Считается в игровом цикле, а не CSS-переходом: капсула — инстанс в
   * InstancedMesh, а не DOM-элемент. Заодно рост замирает на паузе и на экранах
   * вместе со всем остальным — таймер тает по игровому dt.
   */
  private static spawnScale(spawnLeft: number): number {
    const { seconds, peakAt, peakScale } = CONFIG.player.spawnAnim;
    if (spawnLeft <= 0 || seconds <= 0) return 1;

    // Доля пройденного времени. Зажата сверху на случай, когда seconds покрутили
    // на живой игре и остаток оказался длиннее новой длительности.
    const t = Math.min(1, Math.max(0, 1 - spawnLeft / seconds));

    if (t < peakAt) {
      const eased = cubicBezierEase(0.25, 0.1, 0.25, 1, t / peakAt);
      // Нулевой масштаб в three делит нормали инстанса на длину его столбцов и
      // даёт NaN. Пикселей у выродившейся в точку капсулы всё равно нет, но
      // полагаться на то, что NaN нигде не всплывёт, незачем — отсюда порог.
      return Math.max(1e-3, peakScale * eased);
    }

    const eased = cubicBezierEase(0.25, 0.1, 0.25, 1, (t - peakAt) / (1 - peakAt));
    return peakScale + (1 - peakScale) * eased;
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
    const even = nominal % 2 === 0;
    const positive = even ? posInRow % 2 === 0 : posInRow % 2 === 1;

    this.offsetX = (positive ? 1 : -1) * Squad.rowStep(posInRow, nominal) * spacingX;
    // Ряды уходят назад: герой в z = 0, первый ряд союзников за ним.
    this.offsetZ = (row + 1) * spacingZ;
  }

  /**
   * Насколько далеко от центра ряда стоит место posInRow, в шагах spacingX (знак
   * не считается — стороны чередуются). Чётный ряд начинается с ±0.5, нечётный —
   * с 0; отсюда и берётся полушаговый сдвиг соседних рядов.
   *
   * Вынесено из allyOffset, потому что ту же формулу спрашивает halfWidth: она
   * ищет крайнее занятое место, не раскладывая весь строй. Две копии формулы
   * разъехались бы, и предел хода перестал бы отвечать картинке.
   */
  private static rowStep(posInRow: number, nominal: number): number {
    return nominal % 2 === 0 ? Math.floor(posInRow / 2) + 0.5 : Math.ceil(posInRow / 2);
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
      // Урон и дальность — через аксессоры: они учитывают мета-прокачку, причём
      // именно ветку героя (у доп. стрелков ниже она своя).
      const damage = weaponDamage(heroWeapon, 'hero');
      const range = weaponRange(heroWeapon, 'hero');
      // Урон взрыва идёт той же веткой прокачки, что и урон снаряда; у обычных
      // стволов он нулевой, и снаряд остаётся обычным.
      const blastDamage = weaponBlastDamage(heroWeapon, 'hero');
      for (let shot = 0; shot < heroShots; shot++) {
        this.bullets.spawn(squadX, 0, damage, range, heroWeapon, blastDamage, aimX, aimZ);
      }
    }

    const visibleCapacity = Squad.visibleAllyCapacity;
    const hiddenMultiplier = CONFIG.formation.bulletsPerHiddenShooter;

    for (let i = 0; i < this.allies.length; i++) {
      const ally = this.allies[i]!;
      const shots = ally.weapon.tick(dt);
      if (shots === 0) continue;

      const allyWeapon = ally.weapon.weaponId;
      // Союзник бьёт долей от героя (formation.allyDamageFactor): число пуль то
      // же, слабее только каждый снаряд. Доля считается от БАЗЫ оружия, поверх
      // неё ложится ветка прокачки стрелков — темп и дальность тоже её.
      const damage = weaponDamage(allyWeapon, 'ally') * CONFIG.formation.allyDamageFactor;
      const range = weaponRange(allyWeapon, 'ally');
      // Доля от героя ложится и на взрыв: иначе граната союзника накрывала бы
      // толпу полным уроном, и ослабление союзника обходилось бы одним стволом.
      const blastDamage = weaponBlastDamage(allyWeapon, 'ally') * CONFIG.formation.allyDamageFactor;
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
          blastDamage,
          aimX,
          aimZ,
        );
      }
    }
  }

  // --- Урон ----------------------------------------------------------------

  /**
   * Удар зомби (ТЗ раздел 5: «бьют ближайшего стрелка»). Им же бьёт неуклоняемая
   * одиночная атака босса — босс тоже зомби, и правила выбора цели у них общие.
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
      this.hurtHero(amount);
      return true;
    }

    this.hurtAlly(bestIndex, amount);
    return true;
  }

  /**
   * AoE босса: урон всем стрелкам внутри круга (ТЗ раздел 10).
   *
   * Именно здесь работает уклонение: круг задан заранее телеграфом, и если отряд
   * успел уйти, попавших не окажется. Возвращает число задетых стрелков.
   */
  damageShootersInCircle(x: number, z: number, radius: number, damage: number): number {
    const radiusSq = radius * radius;
    const squadX = this.x;
    let hit = 0;

    const heroDx = squadX - x;
    const heroDz = 0 - z;
    if (heroDx * heroDx + heroDz * heroDz <= radiusSq) {
      this.hurtHero(damage);
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
      this.hurtAlly(i, damage);
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
    const squadX = this.x;
    let hit = 0;

    if (Math.abs(squadX - centerX) <= halfWidth) {
      this.hurtHero(damage);
      hit++;
    }

    // Идём с конца: погибший боец удаляется splice'ом, и обход не сбивается.
    const visible = this.visibleAllyCount;
    for (let i = visible - 1; i >= 0; i--) {
      this.allyOffset(i);
      if (Math.abs(squadX + this.offsetX - centerX) > halfWidth) continue;

      hit++;
      this.hurtAlly(i, damage);
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
   *
   * СЮДА ЖЕ ПЕРЕЕХАЛ МНОЖИТЕЛЬ ПОЛУЧАЕМОГО УРОНА. Раньше источники урона
   * умножали сами и передавали уже готовое число — это работало, пока множитель
   * был один на весь отряд. Теперь у героя и у союзника свои ветки прокачки, и
   * решать, чей множитель применить, может только та точка, которая знает, кому
   * достался удар. Все три метода выше передают СЫРОЙ урон.
   */

  private hurtHero(amount: number): void {
    const incoming = amount * CONFIG.player.heroMultipliers.damageTakenMultiplier;
    this.heroHp = Math.max(0, this.heroHp - incoming);
    this.heroRegenDelayLeft =
      CONFIG.player.regen.delayAfterDamageSeconds *
      CONFIG.player.heroMultipliers.regenDelayMultiplier;
    this.heroFlashLeft = CONFIG.ui.damageFlash.seconds;
  }

  /** Наносит урон союзнику index; выбитый покидает строй. */
  private hurtAlly(index: number, amount: number): void {
    const ally = this.allies[index];
    if (ally === undefined) return;

    ally.hp -= amount * CONFIG.player.allyMultipliers.damageTakenMultiplier;
    ally.regenDelayLeft =
      CONFIG.player.regen.delayAfterDamageSeconds *
      CONFIG.player.allyMultipliers.regenDelayMultiplier;
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

    /*
     * Новичок выходит с ЛУЧШИМ из двух: общий ствол в пределах доступа
     * (см. setCommonWeapon) или высшая ступень, открытая стрелкам сама по
     * себе (решение пользователя, 2026-08-03). Купленный доступ «Доп.
     * стрелкам» — гарантированный уровень новичка: бустерные бойцы не выходят
     * с пистолетами, когда стрелкам уже открыт автомат, даже если общий ствол
     * отряда пока ниже.
     */
    const chain = CONFIG.weapons.progression as WeaponId[];
    const fromCommon = this.allyWeaponFor(this.commonWeapon);
    const best = this.bestAllyFirearm();
    const allyId = chain.indexOf(best) > chain.indexOf(fromCommon) ? best : fromCommon;
    const allyMaxHp = this.allyMaxHp;
    for (let i = 0; i < added; i++) {
      this.allies.push({
        hp: allyMaxHp,
        // Случайная фаза: одинаковые накопители у всех дали бы залпы вместо потока.
        weapon: new WeaponState(allyId, 'ally', Math.random()),
        // Новый боец урона не получал — ни паузы регенерации, ни вспышки.
        regenDelayLeft: 0,
        flashLeft: 0,
        // Единственная точка, где ставится рост: сюда приходят и бочки, и ворота.
        spawnLeft: CONFIG.player.spawnAnim.seconds,
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
    this.setCommonWeapon(next);
    return next;
  }

  /**
   * Выдаёт стрелковый ствол ВСЕМУ отряду. Бойцов с особым оружием пропускает —
   * причина в комментарии к upgradeSquadWeapon.
   *
   * Отдельно от него, потому что источников теперь два: бочка поднимает оружие
   * на СЛЕДУЮЩУЮ ступень, стартовый кит выдаёт КОНКРЕТНУЮ. Раздача при этом
   * одна на оба, иначе они разошлись бы в обращении с особым оружием.
   */
  private setCommonWeapon(id: WeaponId): void {
    this.commonWeapon = id;

    // Стрелкам — не сам подобранный ствол, а лучшее ОТКРЫТОЕ ИМ не выше него:
    // доступ стрелков покупается в магазине отдельно от геройского
    // (CONFIG.shop.allyWeaponPriceDivisor).
    const allyId = this.allyWeaponFor(id);
    if (!isSpecialWeapon(this.heroWeapon.weaponId)) this.heroWeapon.setWeapon(id);
    for (const ally of this.allies) {
      if (!isSpecialWeapon(ally.weapon.weaponId)) ally.weapon.setWeapon(allyId);
    }
  }

  /**
   * Вправе ли доп. стрелок держать этот ствол: открыт ему в магазине
   * («Доп. стрелкам») ЛИБО арендован в кит на этот забег — аренда обходит
   * замки магазина целиком, включая доступ стрелков (см.
   * CONFIG.shop.startBonuses). Правило возвращено пользователем 2026-08-03
   * после короткого отката: без него кит «автомат + стрелки» терял смысл —
   * оплаченный ствол доставался одному герою.
   */
  private allyMayHold(id: WeaponId): boolean {
    return this.allyAccess.isAllyWeaponUnlocked(id) || this.rentedWeapons.includes(id);
  }

  /**
   * Лучший ствол, который достанется доп. стрелку вместо подобранного: сам
   * ствол, если открыт, иначе ближайшая открытая ступень ниже по прогрессии.
   * Дно — стартовый пистолет: он вне магазина и открыт всем.
   */
  private allyWeaponFor(id: WeaponId): WeaponId {
    if (this.allyMayHold(id)) return id;

    const chain = CONFIG.weapons.progression as WeaponId[];
    for (let i = chain.indexOf(id) - 1; i >= 0; i--) {
      if (this.allyMayHold(chain[i]!)) return chain[i]!;
    }
    return chain[0]!;
  }

  /**
   * Высшая стрелковая ступень, открытая доп. стрелкам сама по себе, без
   * оглядки на общий ствол. Пол выдачи новичка в addShooters.
   */
  private bestAllyFirearm(): WeaponId {
    const chain = CONFIG.weapons.progression as WeaponId[];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (this.allyMayHold(chain[i]!)) return chain[i]!;
    }
    return chain[0]!;
  }

  /**
   * Ствол из стартового кита — оплаченный за деньги на экране бустеров
   * (см. MetaProgress, «Стартовый кит»). Зовётся из Game.startRun сразу после
   * reset(), то есть до того, как отряд успел что-либо подобрать.
   *
   * Раздаётся по тем же правилам, что и подобранный из бочки: стрелковое
   * достаётся всему отряду, особое — одному бойцу (на старте это герой, он в
   * отряде один). Иначе оплаченный гранатомёт вёл бы себя не так, как найденный,
   * и «взял в кит» означало бы не то же самое, что «выбил из бочки».
   */
  equipStartWeapon(id: WeaponId): void {
    // Аренда обходит замки магазина, включая доступ стрелков: оплаченный на
    // забег ствол держат все. Отмечается ДО выдачи, иначе setCommonWeapon
    // урезал бы его стрелкам прямо на старте.
    this.rentedWeapons.push(id);
    if (isSpecialWeapon(id)) this.giveSpecialWeapon(id);
    else this.setCommonWeapon(id);
  }

  /**
   * Бонус «особое оружие» (ТЗ раздел 6): заменяет ствол у ОДНОГО бойца.
   *
   * Достаётся СЛАБЕЙШЕМУ по шкале specialWeaponRank из тех, кого ствол
   * усиливает: гранатомёт сначала идёт тем, у кого нет ни огнемёта, ни
   * гранатомёта, и только когда таких не осталось — заменяет огнемёт.
   * Огнемёт поверх гранатомёта не выдаётся вовсе — это был бы даунгрейд.
   *
   * Внутри одной ступени порядок по ТЗ: сначала главный герой, затем доп.
   * стрелки в случайном порядке. Кандидат выбирается резервуарной выборкой —
   * один проход и без промежуточного массива, зато распределение равномерное.
   *
   * Возвращает, кому досталось; null — усиливать некого, ствол пропал.
   * Такой бочке не дают появиться проверки полезности на спавне
   * (BarrelField.randomContent/randomSpecial), сюда null доходит только если
   * состав отряда успел смениться между спавном бочки и вскрытием.
   */
  giveSpecialWeapon(id: WeaponId): 'hero' | 'ally' | null {
    const newRank = specialWeaponRank(id);

    // Стрелок без купленного доступа к этому особому кандидатом не считается —
    // особое подчиняется тому же правилу магазина, что и стрелковое
    // (см. allyMayHold); герой держит всё открытое ему.
    const allyEligible = this.allyMayHold(id);

    const heroRank = specialWeaponRank(this.heroWeapon.weaponId);
    let weakest = heroRank < newRank ? heroRank : Infinity;
    if (allyEligible) {
      for (const ally of this.allies) {
        const rank = specialWeaponRank(ally.weapon.weaponId);
        if (rank < newRank && rank < weakest) weakest = rank;
      }
    }
    if (weakest === Infinity) return null;

    if (heroRank === weakest) {
      this.heroWeapon.setWeapon(id);
      return 'hero';
    }

    let chosen = -1;
    let seen = 0;
    for (let i = 0; i < this.allies.length; i++) {
      if (specialWeaponRank(this.allies[i]!.weapon.weaponId) !== weakest) continue;
      seen++;
      if (Math.random() * seen < 1) chosen = i;
    }

    this.allies[chosen]!.weapon.setWeapon(id);
    return 'ally';
  }

  /**
   * Способен ли этот особый ствол усилить хоть кого-то в отряде — по той же
   * шкале, что и giveSpecialWeapon. По этому предикату бочки не предлагают
   * бесполезное особое: огнемёт отряду, полностью вооружённому гранатомётами,
   * не выпадает вовсе.
   */
  specialWeaponBenefits(id: WeaponId): boolean {
    const newRank = specialWeaponRank(id);
    if (specialWeaponRank(this.heroWeapon.weaponId) < newRank) return true;
    // Стрелки — только при купленном им доступе, тем же правилом, что и в
    // giveSpecialWeapon: иначе бочка предлагала бы ствол, который никто не возьмёт.
    if (!this.allyMayHold(id)) return false;
    for (const ally of this.allies) {
      if (specialWeaponRank(ally.weapon.weaponId) < newRank) return true;
    }
    return false;
  }

  /**
   * Бонус «мина» из бочки (ТЗ раздел 7): отряд расставляет мины перед собой.
   * Позицию берём текущую — мины ложатся в ту полосу, где отряд сейчас стоит.
   */
  deployMines(count?: number): void {
    this.mines.place(this.x, count);
  }

  /**
   * Перечисляет полоски HP: герой и видимые союзники с НЕПОЛНЫМ запасом.
   *
   * Таймера показа у стрелков нет, в отличие от зомби: полоска зажигается при
   * уроне сама (запас перестал быть полным) и гаснет, когда регенерация его
   * доберёт. Промежуточного состояния «урон был, а полоски уже нет» не остаётся.
   *
   * Бойцы за визуальным потолком пропущены: у них нет своего места в строю, рисовать
   * полоску не над чем.
   *
   * Последним аргументом уходит доля белого в заливке: у того, кто прямо сейчас
   * отыгрывает HP, полоска переливается (ui.hpBar.healPulse), у остальных 0.
   * Размер стрелки передают базовый — множитель мельче только у обычных зомби.
   */
  forEachHpBar(
    visit: (
      x: number,
      y: number,
      z: number,
      fraction: number,
      scale: number,
      brightness: number,
    ) => void,
  ): void {
    const { heroCapsule, allyCapsule } = CONFIG.player;
    const heroMaxHp = this.heroMaxHp;
    const allyMaxHp = this.allyMaxHp;
    const offsetY = CONFIG.ui.hpBar.offsetY;
    const squadX = this.x;
    // Фаза общая на весь отряд, поэтому считается один раз на кадр.
    const brightness = this.healPulseBrightness;

    if (this.heroHp < heroMaxHp) {
      const top = heroCapsule.length + heroCapsule.radius * 2;
      const healing = Squad.isRegenerating(this.heroRegenDelayLeft) ? brightness : 0;
      visit(squadX, top + offsetY, 0, this.heroHp / heroMaxHp, 1, healing);
    }

    const allyTop = allyCapsule.length + allyCapsule.radius * 2;
    const visible = this.visibleAllyCount;
    for (let i = 0; i < visible; i++) {
      const ally = this.allies[i]!;
      if (ally.hp >= allyMaxHp) continue;

      this.allyOffset(i);
      const healing = Squad.isRegenerating(ally.regenDelayLeft) ? brightness : 0;
      visit(
        squadX + this.offsetX,
        allyTop + offsetY,
        this.offsetZ,
        ally.hp / allyMaxHp,
        1,
        healing,
      );
    }
  }

  /** Сколько полосок HP сейчас показано — для отладки и проверок. */
  get hpBarsVisible(): number {
    const allyMaxHp = this.allyMaxHp;
    let total = this.heroHp < this.heroMaxHp ? 1 : 0;
    const visible = this.visibleAllyCount;
    for (let i = 0; i < visible; i++) {
      if (this.allies[i]!.hp < allyMaxHp) total++;
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
    limitX: number;
    limitXTarget: number;
    halfWidth: number;
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
      regenDelayLeft: number;
      spawnLeft: number;
      scale: number;
    }>;
    heroRegenDelayLeft: number;
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
        regenDelayLeft: +ally.regenDelayLeft.toFixed(3),
        spawnLeft: +ally.spawnLeft.toFixed(3),
        scale: +Squad.spawnScale(ally.spawnLeft).toFixed(3),
      };
    });

    return {
      x: squadX,
      limitX: +this.limitX.toFixed(3),
      limitXTarget: +this.limitXTarget.toFixed(3),
      halfWidth: +this.halfWidth.toFixed(3),
      heroHp: this.heroHp,
      weapon: this.commonWeapon,
      heroWeapon: this.heroWeapon.weaponId,
      specials: this.specialWeaponCount,
      visible: this.visibleAllyCount,
      hidden: this.hiddenAllyCount,
      allies,
      heroRegenDelayLeft: +this.heroRegenDelayLeft.toFixed(3),
    };
  }
}
