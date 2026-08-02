import { AxesHelper, Scene, WebGLRenderer } from 'three';
import { CONFIG } from '../config';
import { BarrelField } from '../entities/barrels';
import { BonusSlot } from '../entities/bonusSlot';
import { Boss } from '../entities/boss';
import { BulletPool } from '../entities/bullets';
import { CrystalPool } from '../entities/crystals';
import { EnemyPool } from '../entities/enemies';
import { GateField } from '../entities/gates';
import { MineField } from '../entities/mines';
import { MoneyPool } from '../entities/money';
import { Squad } from '../entities/squad';
import { Hud } from '../ui/hud';
import { LabelLayer } from '../ui/labels';
import { Screens } from '../ui/screens';
import { createGameCamera } from '../world/camera';
import { World } from '../world/world';
import { PointerInput } from './input';
import { GameLoop } from './loop';
import { MetaProgress } from './meta';
import { RunState } from './run';
import { Viewport } from './viewport';

/**
 * Фаза приложения: идёт забег, герой падает, показан результат или экран прокачки.
 *
 * 'dying' — сцена прощания между смертью героя и экраном результата: ходьба
 * остановлена, шагает только анимация падения (см. update).
 */
export type GamePhase = 'running' | 'dying' | 'result' | 'upgrade';

/**
 * Корень игры: владеет сценой, рендером, камерой и подсистемами.
 *
 * update(dt) вызывается с фиксированным шагом и раздаёт его подсистемам —
 * новые слои (enemies, barrels, gates, weapons) подключаются сюда.
 * Подсистемы публичные: так их видно из dev-хука window.__game при отладке.
 */
export class Game {
  readonly run = new RunState();
  readonly meta = new MetaProgress();
  readonly screens: Screens;
  readonly world: World;
  readonly bullets: BulletPool;
  readonly crystals: CrystalPool;
  /** Монеты денег: та же механика подбора, что у кристаллов, другая валюта. */
  readonly money: MoneyPool;
  readonly enemies: EnemyPool;
  readonly mines: MineField;
  readonly squad: Squad;
  readonly barrels: BarrelField;
  readonly gates: GateField;
  /** Общий слот бонусов: на экране одновременно допустим только один. */
  readonly bonusSlot = new BonusSlot();
  readonly boss: Boss;
  readonly input: PointerInput;
  readonly hud: Hud;
  readonly labels: LabelLayer;

  /** Публичная — нужна для проверки, куда на экране попадает игровая координата. */
  readonly camera;

  private readonly scene = new Scene();
  private readonly renderer: WebGLRenderer;
  private readonly viewport: Viewport;
  private readonly loop: GameLoop;

  /**
   * Игра открывается экраном прокачки, а не забегом: накопленный в прошлых
   * сессиях опыт лежит в localStorage, и первым делом игрок должен увидеть, что
   * его есть на что потратить. Забег начинается кнопкой «Начать забег».
   */
  private phase: GamePhase = 'upgrade';

  /** Сколько ещё длится сцена прощания. Тикает только в фазе 'dying'. */
  private deathLeft = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

    // Реальный aspect выставит Viewport сразу в конструкторе.
    this.camera = createGameCamera(1);
    this.viewport = new Viewport(canvas, this.renderer, this.camera);

    this.world = new World(this.scene);
    this.bullets = new BulletPool(this.scene);
    this.crystals = new CrystalPool(this.scene);
    // Монеты создаются до зомби и босса: оба роняют их в своей воронке смерти.
    this.money = new MoneyPool(this.scene);
    this.enemies = new EnemyPool(this.scene, this.run, this.crystals, this.money);
    // Порядок создания разрывает цикл зависимостей: мины знают зомби, отряд —
    // мины, бочки — отряд, и только потом бочки попадают в цели взрыва.
    this.mines = new MineField(this.scene, this.enemies);
    this.squad = new Squad(this.scene, this.bullets, this.mines);
    // meta бочкам нужна как магазин: непокупленное оружие в них не появляется.
    this.barrels = new BarrelField(
      this.scene,
      this.squad,
      this.crystals,
      this.run,
      this.bonusSlot,
      this.meta,
    );
    this.gates = new GateField(this.scene, this.squad, this.run, this.bonusSlot);
    this.boss = new Boss(this.scene, this.squad, this.run, this.crystals, this.money);
    this.mines.addAreaTarget(this.barrels);
    this.mines.addAreaTarget(this.boss);
    // Слот заполняется после создания полей: бочки и ворота делят его на двоих, и
    // каждое поле должно видеть занятость соседа.
    this.bonusSlot.add(this.barrels);
    this.bonusSlot.add(this.gates);
    this.input = new PointerInput(canvas);
    this.hud = new Hud();
    this.labels = new LabelLayer();
    this.screens = new Screens(this.meta, {
      openUpgrade: () => this.openUpgrade(),
      startRun: () => this.startRun(),
    });

    // Купленное в прошлых сессиях должно действовать с первого забега.
    this.meta.applyTo();

    if (CONFIG.debug.showAxes) {
      this.scene.add(new AxesHelper(5));
    }

    this.loop = new GameLoop(
      (dt) => this.update(dt),
      () => this.render(),
    );

    // Через openUpgrade, а не показом экрана напрямую: так путь в прокачку один и
    // тот же и при старте, и после забега.
    this.openUpgrade();
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** Текущая фаза приложения. */
  get currentPhase(): GamePhase {
    return this.phase;
  }

  /**
   * Конец забега — только смерть героя. Босс концом больше не является: после
   * него начинается следующая волна, поэтому исхода «победа» не существует, а
   * счётом забега стал номер достигнутой волны.
   *
   * EXP уходит в банк: копить за проигрыш нормально для rogue-like, иначе
   * неудачный забег не даёт вообще ничего.
   *
   * ЗДЕСЬ ЖЕ СРАБАТЫВАЕТ МНОЖИТЕЛЬ ОПЫТА (run.expEarned): во время забега счётчик
   * показывает собранное как есть, а прокачка прибавляет один раз на выходе.
   * Экран результата получает оба числа, чтобы объяснить разницу.
   */
  private finishRun(): void {
    const collected = this.run.exp;
    const earned = this.run.expEarned;
    this.meta.deposit(earned);
    // Деньги уходят в банк как есть: множителя у них нет, и собранное за забег
    // равно зачисленному. Отдельным вызовом, а не внутри deposit: это разные
    // валюты, и общая точка зачисления скрыла бы, что одна из них множится.
    this.meta.depositMoney(this.run.money);
    this.phase = 'result';
    this.screens.showResult({
      collectedExp: collected,
      earnedExp: earned,
      money: this.run.money,
      elapsedSeconds: this.run.elapsedSeconds,
      wave: this.run.waveNumber,
    });
  }

  private openUpgrade(): void {
    this.phase = 'upgrade';
    this.screens.showUpgrade();
  }

  /** Новый забег: применить прокачку, обнулить всё, вернуться в игру. */
  private startRun(): void {
    // Прокачка в конфиг ДО сброса: подсистемы читают уже новые значения.
    this.meta.applyTo();

    this.run.reset();
    this.squad.reset();
    this.enemies.reset();
    this.barrels.reset();
    this.gates.reset();
    this.mines.reset();
    this.bullets.reset();
    this.crystals.reset();
    this.money.reset();
    this.boss.reset();

    // Отряд встаёт в центр, а не туда, где курсор остался с прошлого забега.
    this.input.targetPercent = 50;

    this.deathLeft = 0;
    this.phase = 'running';
    this.screens.hide();
  }

  private update(dt: number): void {
    /*
     * СЦЕНА ПРОЩАНИЯ. Герой мёртв, но экрана результата ещё нет: сначала ходьба
     * останавливается, потом капсула падает (deathAnim.fallSeconds), потом
     * выдерживается пауза (deathAnim.resultDelaySeconds).
     *
     * Из всей игры шагает ровно одна вещь — падение героя. Мир, зомби, пули,
     * часы забега и HUD стоят: «остановить ходьбу» означает буквально стоп-кадр,
     * иначе смерть терялась бы в продолжающемся движении дороги. Заодно герой
     * гарантированно не получает урона после смерти и время забега на экране
     * результата остаётся тем, что было в момент гибели.
     */
    if (this.phase === 'dying') {
      this.squad.updateHeroDeath(dt);
      this.deathLeft -= dt;
      if (this.deathLeft <= 0) this.finishRun();
      return;
    }

    // На экранах игровой шаг не идёт, но рендер продолжается: сцена видна за
    // оверлеем, и переход не выглядит зависанием.
    if (this.phase !== 'running') return;

    // Порядок: ввод задал цель → отряд поехал и выстрелил → зомби и бочки
    // придвинулись и задели отряд → пули полетели и разобрали попадания → мир.
    // Герой стреляет уже из обновлённой позиции, пуля не отстаёт от него на кадр.
    // Цели двигаются до пуль, поэтому попадания считаются по их актуальным
    // координатам, а не по прошлому кадру.
    // Часы забега идут первыми: по ним EnemyPool разгоняет плотность спавна.
    this.run.advance(dt);
    this.updateBossPhase();

    this.squad.update(dt, this.input.targetPercent);
    this.enemies.update(dt, this.squad);
    this.barrels.update(dt);
    this.gates.update(dt);
    this.boss.update(dt);
    // Мины после зомби: подход проверяется по их актуальным координатам.
    this.mines.update(dt);
    this.bullets.update(dt, this.tryHitAnything);
    // Кристаллы после пуль: выпавшие с только что убитого зомби едут сразу.
    this.crystals.update(dt, this.squad.x, this.collectExp);
    // Монеты — там же и по той же причине: выпадают в той же воронке смерти.
    this.money.update(dt, this.squad.x, this.collectMoney);
    this.world.update(dt);

    this.hud.update({
      weapon: this.squad.weaponId,
      shooters: this.squad.shooterCount,
      hiddenShooters: this.squad.hiddenAllyCount,
      specials: this.squad.specialWeaponCount,
      enemies: this.enemies.activeCount,
      bigEnemies: this.enemies.bigActiveCount,
      corpses: this.enemies.corpseCount,
      bullets: this.bullets.activeCount,
      killed: this.enemies.killed,
      barrels: this.barrels.activeCount,
      barrelsBroken: this.barrels.broken,
      mines: this.mines.activeCount,
      minesArmed: this.mines.armedCount,
      crystals: this.crystals.activeCount,
      coins: this.money.activeCount,
      exp: this.run.exp,
      money: this.run.money,
      elapsedSeconds: this.run.elapsedSeconds,
      wave: this.run.waveNumber,
      zombiesRemaining: this.run.remainingZombies,
      zombiesTotal: this.run.totalZombies,
      hasBoss: this.run.hasBoss,
      boss: {
        active: this.boss.isActive,
        hp: this.boss.hpRemaining,
        layersRemaining: this.boss.layersRemaining,
        layerFill: this.boss.currentLayerFill,
      },
    });

    this.checkRunEnd();
  }

  /**
   * Проверка конца забега. Идёт после обновления HUD, чтобы на экране результата
   * за оверлеем осталась последняя корректная картина забега.
   *
   * Экран результата открывается не здесь, а в конце сцены прощания (см. update):
   * смерть героя сначала показывается падением капсулы.
   */
  private checkRunEnd(): void {
    if (this.squad.heroHp > 0) return;

    this.phase = 'dying';
    this.deathLeft = CONFIG.deathAnim.fallSeconds + CONFIG.deathAnim.resultDelaySeconds;
    this.squad.startHeroDeath();
  }

  /**
   * Выход босса, переход к следующей волне и переключение режима забега
   * (ТЗ раздел 10).
   *
   * Босс появляется, когда волна зачищена: бюджет спавна исчерпан И на поле не
   * осталось зомби. Пока он на поле — бонусы и ворота не спавнятся, а отряд
   * авто-наводит огонь на него.
   *
   * Убитый босс не заканчивает забег, а открывает следующую волну: бюджет зомби
   * наполняется заново и поток становится плотнее. Босс при этом возвращается в
   * 'absent' и выйдет снова, когда будет зачищена и новая волна.
   *
   * Переход происходит на шаге, СЛЕДУЮЩЕМ за смертью босса: умирает он внутри
   * bullets.update, то есть уже после этой функции. Задержка в 1/60 секунды
   * нужна, чтобы кристаллы с босса успели выпасть в старом состоянии волны.
   */
  private updateBossPhase(): void {
    if (this.boss.currentPhase === 'dead') {
      this.run.startNextWave();
      // Не reset(): он убрал бы тело босса в том же кадре, в котором оно легло.
      this.boss.prepareNextWave();
    }

    const shouldSpawn =
      this.run.hasBoss &&
      this.boss.currentPhase === 'absent' &&
      this.run.allZombiesSpawned &&
      this.enemies.activeCount === 0;

    if (shouldSpawn) this.boss.spawn();

    const fighting = this.boss.isActive;
    this.barrels.spawnEnabled = !fighting;
    this.gates.spawnEnabled = !fighting;

    // Авто-фокус огня: с боссом на поле пули идут в него, иначе — вперёд.
    const aimZ = this.boss.aimZ;
    this.squad.setAimTarget(aimZ === null ? null : this.boss.aimX, aimZ);
  }

  /**
   * Пуля может попасть в зомби, бочку или секцию стены типа A. Функция одна на
   * всю игру (а не создаётся по кадру), чтобы не мусорить замыканиями в горячем
   * цикле.
   *
   * Турникеты типа B сюда не входят намеренно: по ТЗ они простреливаются
   * насквозь и от стрельбы не меняются.
   *
   * Порядок проверки — зомби, бочки, ворота. Если несколько цели оказались на
   * отрезке полёта за один шаг, попадание достанется первой по списку, хотя
   * правильнее ближайшей. Шаг пули 0.4 units против габаритов цели 0.6–1.2,
   * поэтому совпасть они могут только почти вплотную.
   *
   * Пробивающий снаряд (огнемёт) — единственное исключение из этого порядка:
   * ему нельзя коротким замыканием || отдать первую цель, урон должен достаться
   * ВСЕМ на отрезке. Поэтому цели опрашиваются подряд, а результат берётся
   * только у ворот: стена типа A физически держит огонь, и она единственное,
   * обо что пламя гаснет.
   */
  private readonly tryHitAnything = (
    xFrom: number,
    zFrom: number,
    xTo: number,
    zTo: number,
    damage: number,
    radius: number,
    pierce: boolean,
    blastRadius: number,
    blastDamage: number,
  ): boolean => {
    if (pierce) {
      this.boss.tryHit(xFrom, zFrom, xTo, zTo, damage, radius, true);
      this.enemies.tryHit(xFrom, zFrom, xTo, zTo, damage, radius, true);
      this.barrels.tryHit(xFrom, zFrom, xTo, zTo, damage, radius, true);
      return this.gates.tryHit(xFrom, zFrom, xTo, zTo, damage, radius);
    }

    const hit =
      this.boss.tryHit(xFrom, zFrom, xTo, zTo, damage, radius) ||
      this.enemies.tryHit(xFrom, zFrom, xTo, zTo, damage, radius) ||
      this.barrels.tryHit(xFrom, zFrom, xTo, zTo, damage, radius) ||
      this.gates.tryHit(xFrom, zFrom, xTo, zTo, damage, radius);

    // Взрыв — ПОСЛЕ прямого урона и только по факту попадания: граната рвётся
    // о цель, а не в конце дальности. Промах уходит в никуда, как и раньше.
    if (hit && blastRadius > 0) this.explode(xTo, zTo, blastRadius, blastDamage);

    return hit;
  };

  /**
   * Взрыв снаряда (граната) — тот же круг, что у мины, и через те же воронки
   * урона, поэтому сопротивление целей, полоски HP и вспышки учитываются сами.
   *
   * Ворота в список не входят: стена типа A ломается только прямым попаданием.
   * Урон по площади у неё и не с чем считать — секции стоят вплотную, круг
   * радиуса 2 накрыл бы половину стены с одного выстрела.
   *
   * Точка взрыва — КОНЕЦ отрезка полёта за шаг, а не точное место касания цели:
   * шаг пули 0.8 units против радиуса взрыва 2, разница внутри самой зоны.
   *
   * Цель, в которую попали, стоит в центре круга и получает обе части урона —
   * прямую и взрывную. Так и задумано, см. CONFIG.weapons.grenadeLauncher.
   */
  private explode(x: number, z: number, radius: number, damage: number): void {
    this.enemies.damageInRadius(x, z, radius, damage);
    this.boss.damageInRadius(x, z, radius, damage);
    this.barrels.damageInRadius(x, z, radius, damage);
  }

  /** Собранный кристалл идёт в счётчик забега. Ссылка одна на всю игру. */
  private readonly collectExp = (value: number): void => this.run.addExp(value);

  /** Собранная монета — в счётчик денег забега. */
  private readonly collectMoney = (value: number): void => this.run.addMoney(value);

  /** Одна ссылка на всю игру — подписи собираются каждый кадр. */
  private readonly addLabel = (
    x: number,
    y: number,
    z: number,
    value: string,
    icon: string,
    variant: string,
  ): void => this.labels.add(x, y, z, value, icon, variant);

  /**
   * Одна ссылка на всю игру — полоски собираются каждый кадр.
   * scale по умолчанию 1: стрелки его не передают, размер у них базовый.
   */
  private readonly addHpBar = (
    x: number,
    y: number,
    z: number,
    fraction: number,
    scale = 1,
  ): void => this.labels.addBar(x, y, z, fraction, scale);

  private render(): void {
    this.renderer.render(this.scene, this.camera);

    // Подписи считаются после рендера: renderer.render обновляет матрицы камеры,
    // без которых проекция мировых координат на экран даёт мусор.
    this.labels.begin(this.camera, this.viewport.cssWidth, this.viewport.cssHeight);
    this.barrels.forEachLabel(this.addLabel);
    this.gates.forEachLabel(this.addLabel);
    // У зомби подписей нет: их запас показывают только полоски ниже.
    // Полоски HP: зомби — те, кому досталось в последние ui.hpBar.showSeconds,
    // стрелки — все с неполным запасом (см. ui.hpBar).
    // Босс сюда не входит — у него своя многослойная полоса в HUD.
    this.enemies.forEachHpBar(this.addHpBar);
    this.squad.forEachHpBar(this.addHpBar);
    this.labels.end();
  }

  dispose(): void {
    this.stop();
    this.input.dispose();
    this.viewport.dispose();
    this.renderer.dispose();
  }
}
