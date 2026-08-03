import { AxesHelper, Scene, WebGLRenderer } from 'three';
import { CONFIG } from '../config';
import { BarrelField } from '../entities/barrels';
import { BonusSlot } from '../entities/bonusSlot';
import { Boss } from '../entities/boss';
import { BulletPool } from '../entities/bullets';
import { CrystalPool } from '../entities/crystals';
import { EnemyPool } from '../entities/enemies';
import { ExplosionPool } from '../entities/explosions';
import { GateField } from '../entities/gates';
import { MineField } from '../entities/mines';
import { MoneyPool } from '../entities/money';
import { Squad } from '../entities/squad';
import { Hud } from '../ui/hud';
import { LabelLayer } from '../ui/labels';
import { Screens } from '../ui/screens';
import { CameraSpace, createGameCamera } from '../world/camera';
import { World } from '../world/world';
import { PointerInput } from './input';
import { GameLoop } from './loop';
import { MetaProgress } from './meta';
import { RunState } from './run';
import { Viewport } from './viewport';

/**
 * Фаза приложения: идёт забег, герой падает, показан результат, экран прокачки
 * или экран бустеров.
 *
 * 'dying' — сцена прощания между смертью героя и экраном результата: ходьба
 * остановлена, шагает только анимация падения (см. update).
 *
 * 'boosters' — последний экран перед забегом: покупка бойцов и ствола на этот
 * забег. Через него проходит ЛЮБОЙ вход в игру, и с прокачки, и с результата.
 */
export type GamePhase = 'running' | 'dying' | 'result' | 'upgrade' | 'boosters';

/**
 * Корень игры: владеет сценой, рендером, камерой и подсистемами.
 *
 * update(dt) вызывается шагом по длине кадра и раздаёт его подсистемам —
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
  /** Вспышки взрывов: одна картинка на мины и гранаты. */
  readonly explosions: ExplosionPool;
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

  /**
   * Проекция экран ↔ мир для полёта выпавшего в счётчики HUD. Живёт здесь,
   * потому что камера и размеры холста есть только у Game: пулы получают её
   * готовой и о камере не знают.
   */
  private readonly space: CameraSpace;

  /**
   * Пауза. НЕ фаза, а отдельный признак поверх неё, и по двум причинам.
   *
   * Во-первых, с паузы возвращаются туда же, откуда ушли: и забег, и сцена
   * прощания продолжаются с того же места, а фазой пришлось бы запоминать, куда
   * возвращаться. Во-вторых, гасится ею только шаг ИЗ ЦИКЛА (см. конструктор
   * GameLoop): прямой `__game.update(1 / 60)` из замерочных скриптов работает и
   * на паузе, иначе случайная потеря фокуса тихо останавливала бы замер.
   */
  private paused = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });

    // Реальный aspect выставит Viewport сразу в конструкторе.
    this.camera = createGameCamera(1);
    this.space = new CameraSpace(this.camera);
    this.viewport = new Viewport(canvas, this.renderer, this.camera);

    // Миру нужен забег: скорость наезда дороги — его состояние, на боссфайте она
    // ноль (см. RunState.worldSpeed).
    this.world = new World(this.scene, this.run);
    this.bullets = new BulletPool(this.scene);
    // Кристаллам забег нужен ради множителя опыта волны: он применяется на
    // выпадении, внутри CrystalPool.spawn (см. RunState.expMultiplier).
    this.crystals = new CrystalPool(this.scene, this.run);
    // Монеты создаются до зомби и босса: оба роняют их в своей воронке смерти.
    this.money = new MoneyPool(this.scene);
    this.enemies = new EnemyPool(this.scene, this.run, this.crystals, this.money);
    // Вспышки создаются до мин: поле показывает через них детонацию.
    this.explosions = new ExplosionPool(this.scene, this.run);
    // Порядок создания разрывает цикл зависимостей: мины знают зомби, отряд —
    // мины, бочки — отряд, и только потом бочки попадают в цели взрыва.
    this.mines = new MineField(this.scene, this.enemies, this.run, this.explosions);
    // meta отряду — как магазин доступа стрелков к оружию (AllyWeaponAccess).
    this.squad = new Squad(this.scene, this.bullets, this.mines, this.meta);
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
    this.hud = new Hud(() => this.togglePause());
    this.labels = new LabelLayer();
    this.screens = new Screens(this.meta, {
      openUpgrade: () => this.openUpgrade(),
      openBoosters: () => this.openBoosters(),
      startRun: () => this.startRun(),
      resume: () => this.resume(),
    });

    // Пауза с клавиатуры и по уходу приложения в фон.
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Купленное в прошлых сессиях должно действовать с первого забега.
    this.meta.applyTo();

    if (CONFIG.debug.showAxes) {
      this.scene.add(new AxesHelper(5));
    }

    this.loop = new GameLoop(
      (dt) => {
        // Пауза гасит шаг здесь, а не внутри update: прямой вызов
        // __game.update(1 / 60) должен шагать игру независимо от паузы.
        if (!this.paused) this.update(dt);
      },
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

  /** Стоит ли забег на паузе. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Пауза забега: шаг логики из цикла не идёт, рендер продолжается — за
   * оверлеем виден стоп-кадр.
   *
   * Пауза возможна только там, где что-то тикает: на экранах результата и
   * прокачки останавливать нечего, а лишний оверлей поверх них только сбивал бы.
   * Сцена прощания паузу допускает — уход в фон не должен съедать смерть героя.
   */
  pause(): void {
    if (this.paused) return;
    if (this.phase !== 'running' && this.phase !== 'dying') return;

    this.paused = true;
    this.screens.showPause({
      wave: this.run.waveNumber,
      elapsedSeconds: this.run.elapsedSeconds,
    });
  }

  /** Снятие паузы: забег продолжается ровно с того места, где остановлен. */
  resume(): void {
    if (!this.paused) return;

    this.paused = false;
    this.screens.hidePause();
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  /** Esc ставит паузу и снимает её же — привычное поведение для клавиатуры. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.togglePause();
  };

  /**
   * Приложение потеряло фокус — пауза. Возврат фокуса паузу НЕ снимает: игрок
   * возвращается к экрану, а не в гущу боя, и продолжает сам.
   *
   * Событий два, и они про разное: blur — уход фокуса в другое окно (игра при
   * этом видна), visibilitychange — уход всей вкладки или приложения в фон.
   * Второе на мобильных единственное, что вообще приходит.
   */
  private readonly onWindowBlur = (): void => this.pause();

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.pause();
  };

  /**
   * Конец забега — только смерть героя. Босс концом больше не является: после
   * него начинается следующая волна, поэтому исхода «победа» не существует, а
   * счётом забега стал номер достигнутой волны.
   *
   * EXP уходит в банк: копить за проигрыш нормально для rogue-like, иначе
   * неудачный забег не даёт вообще ничего.
   *
   * ЗДЕСЬ ЖЕ СРАБАТЫВАЮТ МНОЖИТЕЛИ ПРОКАЧКИ (run.expEarned, run.moneyEarned): во
   * время забега счётчики показывают собранное как есть, а прокачка прибавляет
   * один раз на выходе. Экран результата получает по обеих валютам оба числа,
   * чтобы показать умножение целиком.
   */
  private finishRun(): void {
    // Штатно паузы здесь быть не может: на ней шаг из цикла не идёт, а значит и
    // умереть герой не успевает. Снимаем ради ручного прогона замерочным
    // скриптом — он шагает игру и на паузе, и оверлей паузы остался бы поверх
    // экрана результата.
    this.resume();

    // Летящее к счётчикам уже принадлежит игроку: зачисляем до подсчёта итогов,
    // иначе забег недосчитывался бы всего, что не долетело за pickupFlight.seconds.
    this.crystals.flushPending(this.collectExp);
    this.money.flushPending(this.collectMoney);

    const collected = this.run.exp;
    const earned = this.run.expEarned;
    this.meta.deposit(earned);
    // Деньги зачисляются отдельным вызовом, а не внутри deposit: это разные
    // валюты со своими множителями, и общая точка скрыла бы, что их два.
    this.meta.depositMoney(this.run.moneyEarned);

    // Что открылось волной, считается ДО записи рекорда: после неё рекорд уже
    // равен достигнутой волне, и разницы между «было» и «стало» не остаётся.
    const opened = this.meta.weaponsOpenedByWave(this.run.waveNumber);
    this.meta.registerWave(this.run.waveNumber);

    this.phase = 'result';
    this.screens.showResult({
      collectedExp: collected,
      earnedExp: earned,
      collectedMoney: this.run.money,
      earnedMoney: this.run.moneyEarned,
      elapsedSeconds: this.run.elapsedSeconds,
      wave: this.run.waveNumber,
      unlockedWeapons: opened,
    });
  }

  private openUpgrade(): void {
    // Уход с бустеров назад отменяет кит целиком с возвратом денег: выбор
    // живёт, только пока открыт их экран. На остальных путях сюда кит пуст,
    // и вызов ничего не делает.
    this.meta.refundStartKit();
    this.phase = 'upgrade';
    this.screens.showUpgrade();
  }

  /**
   * Экран бустеров — то, что игрок видит между «Начать забег» и самим забегом.
   * Забег начинается уже оттуда, кнопкой «В бой».
   *
   * КОГДА ПОКАЗЫВАТЬ НЕЧЕГО, ЭКРАН ПРОПУСКАЕТСЯ и забег начинается сразу: на
   * пустом кошельке там одни недоступные кнопки, то есть лишнее нажатие по
   * дороге в бой — а проходит по ней игрок каждый забег. Уже собранный кит
   * экран не пропускает даже без денег: игрок должен видеть, с чем выходит.
   */
  private openBoosters(): void {
    if (!this.meta.hasStartKit && !this.meta.hasAffordableBooster) {
      this.startRun();
      return;
    }

    this.phase = 'boosters';
    this.screens.showBoosters();
  }

  /** Новый забег: применить прокачку, обнулить всё, вернуться в игру. */
  private startRun(): void {
    // Прокачка в конфиг ДО сброса: подсистемы читают уже новые значения.
    this.meta.applyTo();

    // Кит забирается ДО сбросов: оплаченная стартовая волна нужна уже
    // run.reset() — по её номеру считаются бюджет, состав и множители. Выдача
    // отряду при этом остаётся ниже, после reset() подсистем.
    const kit = this.meta.consumeStartKit();

    this.run.reset(kit.startWave);
    this.squad.reset();
    this.enemies.reset();
    this.barrels.reset();
    this.gates.reset();
    this.mines.reset();
    this.explosions.reset();
    this.bullets.reset();
    this.crystals.reset();
    this.money.reset();
    this.boss.reset();

    /*
     * СТАРТОВЫЙ КИТ — оплаченные за деньги бойцы и ствол на этот забег
     * (см. MetaProgress, «Стартовый кит»; сам кит забран выше, до сбросов).
     * Выдаётся ПОСЛЕ reset(): тот как раз возвращает отряд к одному герою с
     * пистолетом, и порядок наоборот стёр бы выданное.
     *
     * Порядок выдачи смысловой. Сначала стрелковый ствол: он становится ОБЩИМ
     * оружием отряда. Затем особое: оно ложится герою ПОВЕРХ общего (на старте
     * он в отряде один). Последними бойцы: addShooters вооружает новичков общим
     * оружием — так пара «особое + стрелковое» распадается как задумано:
     * особое герою, стрелковое доп. стрелкам. При другом порядке либо бойцы
     * вышли бы с пистолетами, либо особое могло бы достаться не герою.
     */
    // Бусты характеристик — раньше остального кита: они МНОЖАТ значения,
    // записанные applyTo() выше (сам applyTo их бы стёр), а буст предела
    // отряда должен встать в formation.maxShooters до того, как addShooters
    // ниже начнёт по нему резать. За смертью героя бусты снимает следующий
    // applyTo() — на экране прокачки или на старте следующего забега.
    this.meta.applyStartBoosts(kit.boosts);
    if (kit.weapon !== null) this.squad.equipStartWeapon(kit.weapon);
    if (kit.special !== null) this.squad.equipStartWeapon(kit.special);
    if (kit.shooters > 0) this.squad.addShooters(kit.shooters);
    // Предел хода зависит от ширины строя: после выдачи кита он уже другой, и
    // ставить его надо сразу, а не подводить плавно на первых кадрах забега.
    this.squad.snapTravelLimit();

    // Отряд встаёт в центр, а не туда, где курсор остался с прошлого забега.
    this.input.targetPercent = 50;

    this.deathLeft = 0;
    // Забег начинается идущим: паузу с прошлого забега тащить некуда.
    this.paused = false;
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
    // Вспышки после мин и пуль: рождённая в этом же шаге сфера сразу получает
    // первый прирост радиуса и видна с первого кадра.
    this.explosions.update(dt);
    // Кристаллы после пуль: выпавший с только что убитого зомби стартует сразу.
    // Проекция синхронизируется перед ними обоими — камера и холст общие.
    this.space.sync(this.viewport.cssWidth, this.viewport.cssHeight);
    const expAnchor = this.hud.expAnchor;
    this.crystals.update(dt, this.space, expAnchor.x, expAnchor.y, this.collectExp);
    // Монеты — там же и по той же причине: выпадают в той же воронке смерти.
    const moneyAnchor = this.hud.moneyAnchor;
    this.money.update(dt, this.space, moneyAnchor.x, moneyAnchor.y, this.collectMoney);
    this.world.update(dt);

    this.hud.update({
      weapon: this.squad.weaponId,
      shooters: this.squad.shooterCount,
      hiddenShooters: this.squad.hiddenAllyCount,
      specials: this.squad.specialWeaponCount,
      enemies: this.enemies.activeCount,
      bigEnemies: this.enemies.bigActiveCount,
      fastEnemies: this.enemies.fastActiveCount,
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
      fps: this.loop.fps,
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
   * авто-наводит огонь на него. А как только он встаёт на свою линию, встаёт и
   * мир: бой идёт на остановившейся дороге.
   *
   * Убитый босс не заканчивает забег, а открывает следующую волну: бюджет зомби
   * наполняется заново и поток становится плотнее. Босс при этом возвращается в
   * 'absent' и выйдет снова, когда будет зачищена и новая волна.
   *
   * Переход происходит на шаге, СЛЕДУЮЩЕМ за смертью босса: умирает он внутри
   * bullets.update, то есть уже после этой функции. Задержка в один шаг логики
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

    /*
     * МИР СТОИТ, ПОКА ИДЁТ БОЙ. Отряд закреплён в z = 0, вперёд его двигает только
     * наезжающая дорога, поэтому остановка мира — это и есть «отряд остановился»:
     * босс дошёл до своей линии, встал, и вместе с ним встают дорога, декор и всё,
     * что она везёт. Камера неподвижна всегда, так что стоп-кадр получается общий.
     *
     * Условие именно 'fighting', а не isActive: на выходе (entering) дорога ещё
     * едет — босса нужно ПРИВЕЗТИ, а не заставить дойти самому (см. Boss.update).
     * Переключение опаздывает на один шаг логики, потому что в 'fighting' босс
     * переходит внутри boss.update, то есть уже после этой функции; при 1/60 это
     * 0.1 units хода дороги, а торможение и так занимает stopEaseSeconds.
     */
    this.run.setWorldMoving(this.boss.currentPhase !== 'fighting');

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
    this.explosions.spawnAt(x, z, radius);
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
   * scale по умолчанию 1, brightness по умолчанию 0: зомби перелива лечения не
   * знают и последний аргумент не передают.
   */
  private readonly addHpBar = (
    x: number,
    y: number,
    z: number,
    fraction: number,
    scale = 1,
    brightness = 0,
  ): void => this.labels.addBar(x, y, z, fraction, scale, brightness);

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
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.input.dispose();
    this.hud.dispose();
    this.viewport.dispose();
    this.renderer.dispose();
  }
}
