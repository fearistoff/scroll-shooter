import {
  CapsuleGeometry,
  CircleGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import { CONFIG } from '../config';
import { segmentHitsCircle, segmentPassesCircle } from '../core/collision';
import type { RunState } from '../core/run';
import type { CrystalPool } from './crystals';
import { FallPose } from './fall';
import { makeCorpseColor, makeFlashColor } from './flash';
import type { MoneyPool } from './money';

/** Фаза боссфайта. */
export type BossPhase = 'absent' | 'entering' | 'fighting' | 'dead';

/** Вид атаки босса. Одновременно идёт ровно одна — см. Boss.updateAttacks. */
export type BossAttackKind = 'aoe' | 'allHit';

/** Отряд с точки зрения босса. */
export interface BossTarget {
  /** Позиция отряда по x — по ней босс намечает AoE. */
  readonly x: number;
  /** Урон всем стрелкам внутри круга (AoE). Возвращает число задетых. */
  damageShootersInCircle(x: number, z: number, radius: number, damage: number): number;
  /** Урон всем стрелкам сразу (неуклоняемая атака). Возвращает число задетых. */
  damageAllShooters(damage: number): number;
}

/**
 * Босс-гигант (ТЗ раздел 10). ЭТО ТОЖЕ ЗОМБИ — зомби-босс, а не отдельный вид
 * противника: визуальный язык у него общий с толпой (замах раздуванием, вспышка
 * светлым оттенком своего цвета), отличаются только числа и набор атак.
 *
 * Один на забег, выходит после того, как волна зачищена. Доезжает до ~1/3 экрана
 * снизу, останавливается и бьёт двумя атаками:
 *   AoE — красный круг-телеграф на земле, через telegraphTime бьёт 50 hp по всем,
 *         кто в круге. Круг намечается по позиции отряда В МОМЕНТ ТЕЛЕГРАФА,
 *         поэтому уводом отряда урон можно избежать — это единственный
 *         «скилловый» момент забега по ТЗ.
 *   по всем — неуклоняемые 12.5 hp сразу всем стрелкам.
 *
 * АТАКИ ПОСЛЕДОВАТЕЛЬНЫЕ, а не параллельные: таймер один на обе (nextIn), и вид
 * следующего удара выбирается броском (attacks.weight). Наложиться они поэтому не
 * могут в принципе — раньше у каждой был свой кулдаун, таймеры бились друг о друга
 * и периодически выдавали два разных удара почти одновременно. Обоснование чисел —
 * в CONFIG.boss.attacks.interval.
 *
 * HP многослойное: полоса из layerCount слоёв, урон снимает текущий слой сверху.
 * Слои — представление одного числа, а не отдельные пулы HP: так «xN осталось»
 * и «суммарное HP» всегда согласованы.
 */
export class Boss {
  private readonly mesh: Mesh;
  /**
   * Тело убитого босса. ОТДЕЛЬНЫЙ меш, хотя геометрия та же самая: живой босс
   * умирает и в тот же кадр волна сменяется (Game.updateBossPhase), а тело должно
   * доехать до края экрана уже после этого. Один меш на две роли пришлось бы
   * делить по времени, и любой сброс между волнами гасил бы тело.
   *
   * Материал тоже свой: у живого он мигает вспышкой урона, телу это не нужно.
   */
  private readonly corpseMesh: Mesh;
  /** Кольцо-телеграф AoE. Лежит на земле, видно только во время замаха. */
  private readonly telegraph: Mesh;

  private phase: BossPhase = 'absent';
  private hp = 0;
  /**
   * Запас, с которым вышел ЭТОТ босс: CONFIG.boss.totalHp × множитель волны
   * (CONFIG.run.waveHpGrowth). Слои полосы считаются от него, а не от конфига,
   * иначе у босса поздней волны слоёв стало бы больше layerCount.
   */
  private maxHp = 0;
  /**
   * Множитель урона волны, в которой вышел ЭТОТ босс
   * (CONFIG.run.waveDamageGrowth). Обе атаки умножаются на него.
   *
   * 1 по умолчанию, а не 0: пока босса нет, атак всё равно нет, но нулевой
   * множитель превратил бы прямой spawn() из отладочного скрипта в безобидного
   * босса, если бы поле когда-нибудь прочли раньше записи.
   */
  private damageMul = 1;
  private posZ = 0;

  /**
   * Обратный отсчёт до следующего УДАРА — общий для обеих атак. Именно до удара,
   * а не до начала сигнала: замах и телеграф читаются из него вычитанием, поэтому
   * пауза между ударами не зависит от того, какая атака выпала.
   */
  private nextIn = 0;
  /**
   * Какая атака будет следующей. Выбирается СРАЗУ после предыдущего удара, а не в
   * момент срабатывания: круг AoE должен лечь на землю за telegraphTime до удара,
   * то есть тип надо знать заранее.
   */
  private nextKind: BossAttackKind = 'aoe';
  /** Сколько раз подряд уже выпал nextKind, считая его самого (attacks.maxSameInRow). */
  private sameKindInRow = 0;
  /** Круг AoE уже лежит на земле — идёт замах. */
  private telegraphActive = false;
  private telegraphX = 0;

  /** Остаток вспышки от урона (ui.damageFlash). Тает по игровому dt. */
  private flashLeft = 0;
  /** Лежит ли на дороге тело босса — оно живёт своей жизнью после его смерти. */
  private corpseActive = false;
  /** Остаток падения тела, секунды (deathAnim.fallSeconds). */
  private corpseFallLeft = 0;
  /** Азимут падения тела, радианы: 0 — на +X, π/2 — на +Z. Любой из 360°. */
  private corpseYaw = 0;
  /** Поза падения тела. Одна на босса: пересчитывается каждый кадр. */
  private readonly corpsePose = new FallPose();
  /** Где сейчас тело: едет с миром, пока не скроется за нижним краем экрана. */
  private corpseZ = 0;
  /**
   * Остаток сжатия после удара, секунды. Как у зомби: замах считается из таймеров
   * атак, а сжатие — нет, потому что после удара таймер уже перезаряжен.
   */
  private recoverLeft = 0;
  /** Материал и цвета для вспышки: босс — обычный меш, не инстанс. */
  private readonly material: MeshStandardMaterial;
  private readonly baseColor = new Color(CONFIG.boss.color);
  /** Вспышка — светлый оттенок собственного цвета босса. */
  private readonly flashColor = makeFlashColor(CONFIG.boss.color);

  private aoeHitsTotal = 0;
  private allHitsTotal = 0;
  private aoeCastTotal = 0;

  constructor(
    scene: Scene,
    private readonly squad: BossTarget,
    private readonly run: RunState,
    private readonly crystals: CrystalPool,
    private readonly money: MoneyPool,
  ) {
    const { capsule, color, telegraph } = CONFIG.boss;

    this.material = new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
    // Геометрия одна на живого и на тело: капсула у них та же самая.
    const capsuleGeometry = new CapsuleGeometry(capsule.radius, capsule.length, 6, 16);
    this.mesh = new Mesh(capsuleGeometry, this.material);
    this.mesh.visible = false;
    scene.add(this.mesh);

    // У тела свой материал, и он сразу тёмный: цвет тела не меняется за его жизнь,
    // а живой босс в это же время может мигать вспышкой — общий материал развёл бы
    // эти два состояния по одному полю.
    this.corpseMesh = new Mesh(
      capsuleGeometry,
      new MeshStandardMaterial({
        color: makeCorpseColor(color),
        roughness: 0.75,
        metalness: 0.05,
      }),
    );
    this.corpseMesh.visible = false;
    scene.add(this.corpseMesh);

    const circle = new CircleGeometry(CONFIG.boss.attacks.aoe.radius, 32);
    circle.rotateX(-Math.PI / 2);
    this.telegraph = new Mesh(
      circle,
      new MeshBasicMaterial({
        color: telegraph.color,
        transparent: true,
        opacity: telegraph.opacity,
      }),
    );
    this.telegraph.visible = false;
    scene.add(this.telegraph);
  }

  get currentPhase(): BossPhase {
    return this.phase;
  }

  /** Босс на поле и в него можно стрелять. */
  get isActive(): boolean {
    return this.phase === 'entering' || this.phase === 'fighting';
  }

  get hpRemaining(): number {
    return Math.max(0, this.hp);
  }

  /** С каким запасом вышел текущий босс — с учётом множителя волны. */
  get totalHp(): number {
    return this.maxHp;
  }

  /**
   * HP одного слоя полосы. Считается от запаса ЭТОГО босса, поэтому слоёв всегда
   * ровно layerCount, какой бы крепкий он ни был.
   */
  get layerHp(): number {
    const { layerCount } = CONFIG.boss;
    return layerCount > 0 ? this.maxHp / layerCount : this.maxHp;
  }

  /** Сколько слоёв ещё не снято, включая текущий (это и есть «×N» на полосе). */
  get layersRemaining(): number {
    if (this.hp <= 0) return 0;
    return Math.ceil(this.hp / this.layerHp);
  }

  /** Заполненность текущего (верхнего) слоя, 0…1 — им рисуется полоса. */
  get currentLayerFill(): number {
    if (this.hp <= 0) return 0;
    const withinLayer = this.hp - (this.layersRemaining - 1) * this.layerHp;
    return Math.min(1, Math.max(0, withinLayer / this.layerHp));
  }

  /** Куда целиться отряду: центр босса. null — босса нет. */
  get aimZ(): number | null {
    return this.isActive ? this.posZ : null;
  }

  get aimX(): number {
    return 0;
  }

  /** Идёт замах AoE — круг на земле виден. */
  get isTelegraphing(): boolean {
    return this.telegraphActive;
  }

  get aoeCasts(): number {
    return this.aoeCastTotal;
  }

  get aoeHits(): number {
    return this.aoeHitsTotal;
  }

  get allHits(): number {
    return this.allHitsTotal;
  }

  /**
   * Возвращает босса в исходное состояние: нового забега он ещё не видел.
   * В отличие от prepareNextWave, убирает и ТЕЛО — на пустой дороге нового забега
   * ему делать нечего.
   */
  reset(): void {
    this.prepareNextWave();
    this.corpseActive = false;
    this.corpseFallLeft = 0;
    this.corpseZ = 0;
    this.corpseMesh.visible = false;
  }

  /**
   * Готовит босса к следующей волне. Зовётся сразу после его смерти, поэтому
   * ТЕЛО НЕ ТРОГАЕТ: оно должно доехать до края экрана уже во время новой волны.
   * Всё остальное обнуляется — следующий босс выйдет с чистого листа.
   */
  prepareNextWave(): void {
    this.phase = 'absent';
    this.hp = 0;
    this.maxHp = 0;
    this.damageMul = 1;
    this.posZ = CONFIG.world.spawnZ;
    this.nextIn = 0;
    this.nextKind = 'aoe';
    this.sameKindInRow = 0;
    this.telegraphActive = false;
    this.telegraphX = 0;
    this.aoeHitsTotal = 0;
    this.allHitsTotal = 0;
    this.aoeCastTotal = 0;
    this.flashLeft = 0;
    this.recoverLeft = 0;
    this.material.color.copy(this.baseColor);
    // Масштаб тоже сбрасывается: босс мог умереть на пике замаха, и следующий
    // забег он начал бы раздутым — меш один на всю игру, его не пересоздают.
    this.mesh.scale.setScalar(1);
    this.mesh.visible = false;
    this.telegraph.visible = false;
  }

  /** Выпускает босса на поле. */
  spawn(): void {
    const { totalHp, attacks } = CONFIG.boss;

    this.phase = 'entering';
    // Босс крепнет с волной наравне с зомби (CONFIG.run.waveHpGrowth).
    this.maxHp = totalHp * this.run.hpMultiplier;
    this.hp = this.maxHp;
    // Урон обеих атак — своим множителем волны, как у зомби.
    this.damageMul = this.run.damageMultiplier;
    this.posZ = CONFIG.world.spawnZ;
    // Первая атака не сразу по прибытии: игрок должен успеть понять, что вышло.
    // Вид её выбирается тем же броском, что и всех остальных, — предсказуемого
    // начала боссфайта нет.
    this.sameKindInRow = 0;
    this.scheduleAttack(attacks.firstAttackDelay);
    this.telegraphActive = false;
    this.telegraph.visible = false;
    // Босс прошлой волны мог погибнуть на пике замаха, а меш один на всю игру:
    // без сброса следующий вышел бы уже раздутым. reset() здесь не поможет — он
    // вызывается только на старте забега, а волн с боссом в забеге много.
    this.recoverLeft = 0;
    this.mesh.scale.setScalar(1);
    this.mesh.visible = true;
  }

  /** Движение к точке остановки и атаки. */
  update(dt: number): void {
    // Тело — первым и вне проверки isActive: живого босса уже нет, а тело едет.
    this.updateCorpse(dt);
    if (!this.isActive) return;

    const { capsule, stopZ, approachSpeed } = CONFIG.boss;

    if (this.flashLeft > 0) this.flashLeft -= dt;
    if (this.recoverLeft > 0) this.recoverLeft -= dt;
    this.material.color.copy(this.flashLeft > 0 ? this.flashColor : this.baseColor);

    if (this.phase === 'entering') {
      // Босс идёт сам плюс его несёт наезжающий мир.
      this.posZ = Math.min(this.posZ + (CONFIG.world.worldSpeed + approachSpeed) * dt, stopZ);
      if (this.posZ >= stopZ) this.phase = 'fighting';
    } else {
      this.updateAttacks(dt);
    }

    // Масштаб считается ПОСЛЕ атак: удар, случившийся в этом кадре, уже поставил
    // recoverLeft, и сжатие начинается с пика, а не со следующего кадра.
    const scale = this.attackScale();
    this.mesh.scale.setScalar(scale);
    // Высота центра капсулы умножается на тот же масштаб — рост идёт от подошвы,
    // иначе раздутый босс провалился бы в дорогу. Круг-телеграф лежит отдельным
    // мешем и не масштабируется: он размечает область урона, а не тело.
    const y = (capsule.length / 2 + capsule.radius) * scale;
    this.mesh.position.set(0, y, this.posZ);
  }

  /**
   * Тело убитого босса: падает набок за deathAnim.fallSeconds и едет с миром,
   * пока не скроется за нижним краем экрана. Правило то же, что у зомби (босс —
   * тоже зомби): сам он больше не идёт, уносит его дорога.
   */
  private updateCorpse(dt: number): void {
    if (!this.corpseActive) return;

    const { capsule } = CONFIG.boss;

    if (this.corpseFallLeft > 0) this.corpseFallLeft = Math.max(0, this.corpseFallLeft - dt);
    this.corpseZ += CONFIG.world.worldSpeed * dt;

    if (this.corpseZ > CONFIG.world.despawnZ) {
      this.corpseActive = false;
      this.corpseMesh.visible = false;
      return;
    }

    // Поза — общая с зомби (босс тоже зомби), считает FallPose: подошва остаётся
    // в (0, corpseZ), а центр капсулы уезжает по дуге вокруг неё в сторону
    // corpseYaw. Наклон вокруг произвольной горизонтальной оси, поэтому rotation.z
    // здесь больше не годится — ставится кватернион.
    const pose = this.corpsePose.set(0, this.corpseZ, this.corpseYaw, this.corpseFallLeft, capsule);
    this.corpseMesh.quaternion.setFromAxisAngle(pose.axis, pose.angle);
    this.corpseMesh.position.set(pose.x, pose.y, pose.z);
  }

  /**
   * Масштаб капсулы босса — анимация атаки, та же, что у зомби
   * (CONFIG.enemies.attackAnim), со своим временем замаха (CONFIG.boss.attackAnim).
   *
   * Сжатие после удара перебивает замах: интервал между ударами (3.5 с) длиннее
   * замаха (1.2 с), так что в норме они и не пересекаются, но порядок «сжатие
   * важнее» оставлен — он не даёт сжатию оборваться, если интервал когда-нибудь
   * укоротят.
   *
   * Замах — только в фазе fighting. На выходе (entering) босс не атакует, и
   * раздуваться ему нечем; заодно это повторяет правило зомби «замах считается
   * только у дошедших до линии остановки».
   *
   * Только чтение: таймеры убывают в update.
   */
  private attackScale(): number {
    const { peakScale, recoverSeconds } = CONFIG.enemies.attackAnim;
    const grow = peakScale - 1;

    if (this.recoverLeft > 0) {
      return 1 + grow * Math.min(this.recoverLeft / recoverSeconds, 1);
    }

    if (this.phase !== 'fighting') return 1;

    const windup = CONFIG.boss.attackAnim.windupSeconds;
    if (windup <= 0) return 1;

    // Таймер один и считает время до УДАРА — что бы ни выпало, замах начинается
    // за windup до него. Раньше здесь сходились два таймера с разными смыслами.
    const strikeIn = this.nextIn;
    if (strikeIn >= windup) return 1;

    return 1 + grow * (1 - Math.max(strikeIn, 0) / windup);
  }

  /**
   * Выбирает следующую атаку и заводит общий таймер на delay секунд до удара.
   *
   * Бросок по весам, но не более maxSameInRow одинаковых подряд: чистая случайность
   * иногда выдаёт длинную серию одной и той же атаки, и она читается не как
   * случайность, а как поломка ритма.
   */
  private scheduleAttack(delay: number): void {
    const { aoe, allHit, maxSameInRow } = CONFIG.boss.attacks;

    let kind: BossAttackKind;
    if (this.sameKindInRow >= maxSameInRow) {
      kind = this.nextKind === 'aoe' ? 'allHit' : 'aoe';
    } else {
      const total = aoe.weight + allHit.weight;
      kind = Math.random() * total < aoe.weight ? 'aoe' : 'allHit';
    }

    this.sameKindInRow = kind === this.nextKind ? this.sameKindInRow + 1 : 1;
    this.nextKind = kind;
    this.nextIn = delay;
  }

  private updateAttacks(dt: number): void {
    const { aoe, allHit, interval } = CONFIG.boss.attacks;

    this.nextIn -= dt;

    // --- Телеграф AoE ложится ровно за telegraphTime до удара, то есть в тот же
    // кадр, в который начинается замах (windupSeconds === telegraphTime).
    if (this.nextKind === 'aoe' && !this.telegraphActive && this.nextIn <= aoe.telegraphTime) {
      // Круг намечается по текущей позиции отряда — дальше он не двигается.
      this.telegraphX = this.squad.x;
      this.telegraph.position.set(this.telegraphX, 0.02, 0);
      this.telegraph.visible = true;
      this.telegraphActive = true;
      this.aoeCastTotal++;
    }

    if (this.nextIn > 0) return;

    // --- Удар
    if (this.nextKind === 'aoe') {
      // Бьём по КРУГУ, а не по отряду: успел уйти — не задело.
      this.aoeHitsTotal += this.squad.damageShootersInCircle(
        this.telegraphX,
        0,
        aoe.radius,
        aoe.damage * this.damageMul,
      );
      this.telegraph.visible = false;
      this.telegraphActive = false;
    } else {
      this.allHitsTotal += this.squad.damageAllShooters(allHit.damage * this.damageMul);
    }

    // Замах кончился ударом — дальше сжатие обратно.
    this.recoverLeft = CONFIG.enemies.attackAnim.recoverSeconds;
    // Интервал накопителем: остаток кадра (nextIn уже отрицательный) переносится в
    // следующий отсчёт, иначе на длинном боссфайте ритм уползал бы на полкадра за удар.
    this.scheduleAttack(this.nextIn + interval);
  }

  /**
   * Попадание пули на отрезке её полёта (передаётся в BulletPool.update).
   * Босс — круг радиуса капсулы в плоскости XZ.
   *
   * Босс — тоже зомби, поэтому пробивающий снаряд (огнемёт) проходит и сквозь
   * него: урон засчитывается один раз на пересечении, а снаряд летит дальше и
   * достаёт тех, кто стоит за боссом.
   */
  readonly tryHit = (
    xFrom: number,
    zFrom: number,
    xTo: number,
    zTo: number,
    damage: number,
    bulletRadius: number = CONFIG.weapons.bullet.radius,
    pierce = false,
  ): boolean => {
    if (!this.isActive) return false;

    const reach = CONFIG.boss.capsule.radius + bulletRadius;
    const touched = pierce
      ? segmentPassesCircle(0, this.posZ, reach, xFrom, zFrom, xTo, zTo)
      : segmentHitsCircle(0, this.posZ, reach, xFrom, zFrom, xTo, zTo);
    if (!touched) return false;

    this.applyDamage(damage);
    return true;
  };

  /** Урон по площади (взрыв мины). Возвращает 1, если босса задело. */
  damageInRadius(x: number, z: number, radius: number, damage: number): number {
    if (!this.isActive) return 0;

    const reach = radius + CONFIG.boss.capsule.radius;
    const dx = x - 0;
    const dz = z - this.posZ;
    if (dx * dx + dz * dz > reach * reach) return 0;

    this.applyDamage(damage);
    return 1;
  }

  private applyDamage(damage: number): void {
    // Сопротивление урону — в воронке, поэтому одинаково гасит и пули, и мины.
    this.hp -= damage * CONFIG.boss.damageResistance;
    this.flashLeft = CONFIG.ui.damageFlash.seconds;
    if (this.hp > 0) return;

    this.hp = 0;
    this.phase = 'dead';
    this.mesh.visible = false;
    this.telegraph.visible = false;
    this.telegraphActive = false;

    // Живой меш прячется, а на его место встаёт тело — с той же точки, где босса
    // застала смерть. Масштаб замаха телу не передаётся: оно падает в свой размер.
    this.corpseActive = true;
    this.corpseFallLeft = CONFIG.deathAnim.fallSeconds;
    this.corpseYaw = Math.random() * Math.PI * 2;
    this.corpseZ = this.posZ;
    this.corpseMesh.visible = true;
    // Поза выставляется общей формулой, а не руками: иначе первый кадр тела
    // рисовался бы по одной раскладке, а все следующие — по другой.
    this.updateCorpse(0);

    // Босс осыпается кристаллами: он один стоит целой волны.
    const drops = Math.max(1, CONFIG.boss.layerCount);
    for (let n = 0; n < drops; n++) {
      const spread = (Math.random() * 2 - 1) * CONFIG.boss.capsule.radius * 2;
      this.crystals.spawn(spread, this.posZ, CONFIG.exp.perBigZombie);
    }

    // Деньги с босса — одной монетой, но крупной, и растут вместе с его запасом
    // прочности: множитель волны тот же самый (run.hpMultiplier). Бросок
    // вероятности общий с обычными зомби — босс тоже зомби, и своего шанса у
    // него нет, см. CONFIG.money.dropChance.
    const moneyScale = CONFIG.money.bossScalesWithHp ? this.run.hpMultiplier : 1;
    this.money.dropFrom(0, this.posZ, 'boss', moneyScale);

    this.run.registerBossKill();
  }

  /** Состояние босса — для отладки и проверок. */
  debugSnapshot(): {
    phase: BossPhase;
    hp: number;
    maxHp: number;
    damageMul: number;
    z: number;
    layersRemaining: number;
    layerFill: number;
    telegraphing: boolean;
    telegraphX: number;
    nextKind: BossAttackKind;
    nextIn: number;
    sameKindInRow: number;
    recoverLeft: number;
    scale: number;
    corpse: {
      active: boolean;
      z: number;
      fallLeft: number;
      tiltDegrees: number;
      yawDegrees: number;
      bodyX: number;
      bodyY: number;
      bodyZ: number;
    };
  } {
    return {
      phase: this.phase,
      hp: +this.hp.toFixed(2),
      maxHp: +this.maxHp.toFixed(2),
      damageMul: +this.damageMul.toFixed(3),
      z: +this.posZ.toFixed(2),
      layersRemaining: this.layersRemaining,
      layerFill: +this.currentLayerFill.toFixed(3),
      telegraphing: this.isTelegraphing,
      telegraphX: +this.telegraphX.toFixed(2),
      // Один таймер на обе атаки: nextKind — что выпало, nextIn — сколько до УДАРА
      // (не до начала телеграфа).
      nextKind: this.nextKind,
      nextIn: +this.nextIn.toFixed(3),
      sameKindInRow: this.sameKindInRow,
      recoverLeft: +this.recoverLeft.toFixed(3),
      // Фактический масштаб меша — по нему проверяется анимация атаки.
      scale: +this.mesh.scale.x.toFixed(3),
      // Тело: наклон 0 — стоит, 90 — лежит; yawDegrees — сторона падения (0 — на
      // +X, 90 — на +Z). bodyX/bodyY/bodyZ — фактический центр капсулы, уехавший
      // по дуге вокруг подошвы; z — сама подошва.
      corpse: {
        active: this.corpseActive,
        z: +this.corpseZ.toFixed(2),
        fallLeft: +this.corpseFallLeft.toFixed(3),
        tiltDegrees: this.corpseActive ? +this.corpsePose.tiltDegrees.toFixed(1) : 0,
        yawDegrees: this.corpseActive ? +((this.corpseYaw * 180) / Math.PI).toFixed(1) : 0,
        bodyX: +this.corpseMesh.position.x.toFixed(3),
        bodyY: +this.corpseMesh.position.y.toFixed(3),
        bodyZ: +this.corpseMesh.position.z.toFixed(3),
      },
    };
  }
}
