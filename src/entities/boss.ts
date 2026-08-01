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
import { makeFlashColor } from './flash';

/** Фаза боссфайта. */
export type BossPhase = 'absent' | 'entering' | 'fighting' | 'dead';

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
 * снизу, останавливается и чередует две атаки:
 *   AoE — красный круг-телеграф на земле, через telegraphTime бьёт 50 hp по всем,
 *         кто в круге. Круг намечается по позиции отряда В МОМЕНТ ТЕЛЕГРАФА,
 *         поэтому уводом отряда урон можно избежать — это единственный
 *         «скилловый» момент забега по ТЗ.
 *   по всем — неуклоняемые 12.5 hp сразу всем стрелкам.
 *
 * HP многослойное: полоса из layerCount слоёв, урон снимает текущий слой сверху.
 * Слои — представление одного числа, а не отдельные пулы HP: так «xN осталось»
 * и «суммарное HP» всегда согласованы.
 */
export class Boss {
  private readonly mesh: Mesh;
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

  /** Обратный отсчёт до следующей атаки каждого типа. */
  private aoeIn = 0;
  private allHitIn = 0;
  /** Если > 0 — идёт замах AoE, круг уже показан. */
  private telegraphIn = 0;
  private telegraphX = 0;

  /** Остаток вспышки от урона (ui.damageFlash). Тает по игровому dt. */
  private flashLeft = 0;
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
  ) {
    const { capsule, color, telegraph } = CONFIG.boss;

    this.material = new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
    this.mesh = new Mesh(
      new CapsuleGeometry(capsule.radius, capsule.length, 6, 16),
      this.material,
    );
    this.mesh.visible = false;
    scene.add(this.mesh);

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
    return this.telegraphIn > 0;
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

  /** Возвращает босса в исходное состояние: нового забега он ещё не видел. */
  reset(): void {
    this.phase = 'absent';
    this.hp = 0;
    this.maxHp = 0;
    this.damageMul = 1;
    this.posZ = CONFIG.world.spawnZ;
    this.aoeIn = 0;
    this.allHitIn = 0;
    this.telegraphIn = 0;
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
    // Первые атаки не сразу по прибытии: игрок должен успеть понять, что вышло.
    this.aoeIn = attacks.firstAttackDelay;
    this.allHitIn = attacks.firstAttackDelay + attacks.allHit.cooldown / 2;
    this.telegraphIn = 0;
    // Босс прошлой волны мог погибнуть на пике замаха, а меш один на всю игру:
    // без сброса следующий вышел бы уже раздутым. reset() здесь не поможет — он
    // вызывается только на старте забега, а волн с боссом в забеге много.
    this.recoverLeft = 0;
    this.mesh.scale.setScalar(1);
    this.mesh.visible = true;
  }

  /** Движение к точке остановки и атаки. */
  update(dt: number): void {
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
   * Масштаб капсулы босса — анимация атаки, та же, что у зомби
   * (CONFIG.enemies.attackAnim), со своим временем замаха (CONFIG.boss.attackAnim).
   *
   * Сжатие после удара перебивает замах: удары двух типов идут по своим кулдаунам
   * и могут сойтись, а сжатие должно доиграть.
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

    // Время до УДАРА, а не до начала замаха. У AoE удар в конце телеграфа,
    // поэтому пока круг на земле — это telegraphIn, а до него ещё и весь телеграф.
    const aoeStrikeIn =
      this.telegraphIn > 0
        ? this.telegraphIn
        : this.aoeIn + CONFIG.boss.attacks.aoe.telegraphTime;
    const strikeIn = Math.min(aoeStrikeIn, this.allHitIn);
    if (strikeIn >= windup) return 1;

    return 1 + grow * (1 - Math.max(strikeIn, 0) / windup);
  }

  private updateAttacks(dt: number): void {
    const { aoe, allHit } = CONFIG.boss.attacks;

    // --- Замах AoE: круг уже на земле, ждём удара
    if (this.telegraphIn > 0) {
      this.telegraphIn -= dt;
      if (this.telegraphIn <= 0) {
        // Бьём по КРУГУ, а не по отряду: успел уйти — не задело.
        this.aoeHitsTotal += this.squad.damageShootersInCircle(
          this.telegraphX,
          0,
          aoe.radius,
          aoe.damage * this.damageMul,
        );
        this.telegraph.visible = false;
        this.aoeIn = aoe.cooldown;
        // Замах кончился ударом — дальше сжатие обратно.
        this.recoverLeft = CONFIG.enemies.attackAnim.recoverSeconds;
      }
    } else {
      this.aoeIn -= dt;
      if (this.aoeIn <= 0) {
        // Круг намечается по текущей позиции отряда — дальше он не двигается.
        this.telegraphX = this.squad.x;
        this.telegraphIn = aoe.telegraphTime;
        this.telegraph.position.set(this.telegraphX, 0.02, 0);
        this.telegraph.visible = true;
        this.aoeCastTotal++;
      }
    }

    // --- Неуклоняемый удар по всем
    this.allHitIn -= dt;
    if (this.allHitIn <= 0) {
      this.allHitIn = allHit.cooldown;
      this.recoverLeft = CONFIG.enemies.attackAnim.recoverSeconds;
      this.allHitsTotal += this.squad.damageAllShooters(allHit.damage * this.damageMul);
    }
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
    this.telegraphIn = 0;

    // Босс осыпается кристаллами: он один стоит целой волны.
    const drops = Math.max(1, CONFIG.boss.layerCount);
    for (let n = 0; n < drops; n++) {
      const spread = (Math.random() * 2 - 1) * CONFIG.boss.capsule.radius * 2;
      this.crystals.spawn(spread, this.posZ, CONFIG.exp.perBigZombie);
    }

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
    aoeIn: number;
    allHitIn: number;
    recoverLeft: number;
    scale: number;
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
      aoeIn: +this.aoeIn.toFixed(3),
      allHitIn: +this.allHitIn.toFixed(3),
      recoverLeft: +this.recoverLeft.toFixed(3),
      // Фактический масштаб меша — по нему проверяется анимация атаки.
      scale: +this.mesh.scale.x.toFixed(3),
    };
  }
}
