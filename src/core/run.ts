import { CONFIG } from '../config';

/** Кого спавнить следующим. */
export type ZombieKind = 'normal' | 'big' | 'fast';

/**
 * Состояние забега (ТЗ раздел 9): бюджет спавна, счётчик волны, накопленный EXP.
 *
 * Вынесено из EnemyPool, потому что это уже не свойство пула зомби, а свойство
 * ЗАБЕГА: полосой волны распоряжается интерфейс, боссом — слой 10, а накопленным
 * EXP — мета-петля слоя 11.
 *
 * Счётчик волны по ТЗ считает всех поштучно: обычный = 1, крупный = 1, босс = 1.
 * Поэтому «осталось» — это разница общего числа и убитых, а не остаток бюджета
 * спавна: уже выпущенный, но живой зомби из забега ещё не ушёл.
 *
 * ВОЛНЫ. Забег не кончается на боссе: после его смерти начинается следующая
 * волна с тем же бюджетом, но более плотным потоком. Счётчики «осталось» и
 * «убито» относятся к ТЕКУЩЕЙ волне и обнуляются при переходе, а часы забега и
 * накопленный EXP идут через все волны насквозь — по часам считаются
 * разблокировки, и обнуление вернуло бы игрока к пистолетным ограничениям.
 */
export class RunState {
  private normalLeft = 0;
  private bigLeft = 0;
  private fastLeft = 0;
  /**
   * Фактические доли ТЕКУЩЕЙ волны. До поздних волн совпадают с лестницами из
   * конфига, а с волны случайного состава (см. waveMixPureChance) — результат
   * розыгрыша, поэтому хранятся, а не считаются заново: доля волны обязана быть
   * одной и той же и для бюджета, и для отладочного снимка.
   */
  private bigShareNow = 0;
  private fastShareNow = 0;
  private killed = 0;
  private expTotal = 0;
  private moneyTotal = 0;
  private bossKilled = false;
  private elapsed = 0;
  private wave = 1;
  /** Итог текущей волны для полосы: обычные + крупные + босс. */
  private waveTotal = 0;
  /**
   * Едет ли мир — цель, к которой стремится worldSpeed. Переключается ровно из
   * одного места, Game.updateBossPhase: на время боя с боссом дорога стоит.
   */
  private worldMoves = true;
  /** Фактическая скорость наезда мира, units/сек. Догоняет цель, а не прыгает к ней. */
  private worldSpeedNow = CONFIG.world.worldSpeed;

  constructor() {
    this.reset();
  }

  /**
   * Сброс к началу забега. startWave > 1 — оплаченный в ките старт с поздней
   * волны (CONFIG.shop.startBonuses.startWave): номер задаёт бюджет, состав и
   * множители первой волны вылазки, а часы забега всё равно идут с нуля —
   * разгон плотности и разблокировки по секундам (run.unlocks) стартуют как в
   * обычной вылазке. Куплен только пропуск ранних волн, а не перемотка забега.
   */
  reset(startWave = 1): void {
    this.expTotal = 0;
    this.moneyTotal = 0;
    this.elapsed = 0;
    this.wave = Math.max(1, Math.floor(startWave));
    // Забег начинается идущим миром: прошлый мог закончиться смертью героя прямо
    // на боссфайте, то есть с остановленной дорогой.
    this.worldMoves = true;
    this.worldSpeedNow = CONFIG.world.worldSpeed;
    this.resetWaveBudget();
  }

  /**
   * Переход к следующей волне: бюджет наполняется заново, поток становится
   * плотнее в CONFIG.run.waveSpawnRateGrowth раз.
   *
   * Зовётся из Game, когда босс умер. Отряд, оружие, EXP и часы сохраняются:
   * пережитый босс — это награда, а не обнуление прогресса.
   */
  startNextWave(): void {
    this.wave++;
    this.resetWaveBudget();
  }

  /** Номер текущей волны, с 1. Он же счёт забега на экране результата. */
  get waveNumber(): number {
    return this.wave;
  }

  /**
   * Во сколько раз плотнее идут зомби в этой волне по сравнению с первой.
   * Множитель кумулятивный: 1, 1.5, 2.25, … Применяется в EnemyPool.spawnInterval.
   */
  get spawnRateMultiplier(): number {
    return CONFIG.run.waveSpawnRateGrowth ** (this.wave - 1);
  }

  /**
   * Во сколько раз больше зомби в этой волне по сравнению с первой.
   * Растёт тем же темпом, что и плотность, поэтому длительность волны держится
   * примерно постоянной (CONFIG.run.waveBudgetGrowth).
   */
  get budgetMultiplier(): number {
    return CONFIG.run.waveBudgetGrowth ** (this.wave - 1);
  }

  /**
   * Какая ДОЛЯ бюджета ТЕКУЩЕЙ волны — крупные зомби. Разыгрывается один раз на
   * старте волны (см. rollWaveMix), внутри волны не меняется.
   */
  get bigShare(): number {
    return this.bigShareNow;
  }

  /** Доля быстрых зомби в текущей волне — симметрично bigShare. */
  get fastShare(): number {
    return this.fastShareNow;
  }

  /**
   * Плановая доля вида по лестнице из конфига: 0 до fromWave, дальше по step за
   * волну (fromWave — один шаг, следующая — два, …) до потолка max.
   *
   * Рост линейный, а не кумулятивный (см. CONFIG.run.bigZombieShareStep), и это
   * доля от ОБЩЕГО числа единиц волны — состав меняется, количество нет.
   */
  private plannedShare(fromWave: number, step: number, max: number): number {
    if (this.wave < fromWave) return 0;
    const steps = this.wave - fromWave + 1;
    return Math.min(max, step * steps);
  }

  /**
   * Первая волна, на которой лестница вида упирается в потолок. Например, шаг
   * 0.1 с потолком 0.5 от волны 2 — это волна 6 (10% → … → 50%). При выключенном
   * виде (step или max ≤ 0) потолок недостижим — Infinity, и случайный состав
   * (см. rollWaveMix) не наступает никогда.
   */
  private static shareCapWave(fromWave: number, step: number, max: number): number {
    if (step <= 0 || max <= 0) return Infinity;
    return fromWave + Math.ceil(max / step) - 1;
  }

  /**
   * Состав волны: доли крупных и быстрых, остаток — обычные.
   *
   * До поздних волн — детерминированные лестницы из конфига (bigZombieShareStep /
   * fastZombieShareStep). Начиная со СЛЕДУЮЩЕЙ волны после той, где обе лестницы
   * упёрлись в потолки (при текущих числах — с волны 8), состав случайный
   * (решение пользователя): суммарная доля крупных и быстрых равна сумме
   * потолков (при 0.5 + 0.5 обычных не остаётся вовсе), а граница между ними —
   * с вероятностью waveMixPureChance волна ЧИСТАЯ (целиком крупные или целиком
   * быстрые, поровну), иначе равномерно случайная.
   *
   * Розыгрыш происходит ОДИН РАЗ, на старте волны из resetWaveBudget: внутри
   * волны состав бюджета не меняется — по той же причине, по которой гейт видов
   * стоит на номере волны, а не на секунде забега (см. bigZombieFromWave).
   */
  private rollWaveMix(): { big: number; fast: number } {
    const {
      bigZombieFromWave,
      bigZombieShareStep,
      bigZombieShareMax,
      fastZombieFromWave,
      fastZombieShareStep,
      fastZombieShareMax,
      waveMixPureChance,
    } = CONFIG.run;

    const randomFromWave =
      Math.max(
        RunState.shareCapWave(bigZombieFromWave, bigZombieShareStep, bigZombieShareMax),
        RunState.shareCapWave(fastZombieFromWave, fastZombieShareStep, fastZombieShareMax),
      ) + 1;

    if (this.wave < randomFromWave) {
      return {
        big: this.plannedShare(bigZombieFromWave, bigZombieShareStep, bigZombieShareMax),
        fast: this.plannedShare(fastZombieFromWave, fastZombieShareStep, fastZombieShareMax),
      };
    }

    // Случайная фаза. Сумма долей — сумма потолков: при 0.5 + 0.5 это ровно вся
    // волна, при потолках поменьше остаток по-прежнему достаётся обычным.
    const mixShare = Math.min(1, bigZombieShareMax + fastZombieShareMax);

    if (Math.random() < waveMixPureChance) {
      return Math.random() < 0.5 ? { big: mixShare, fast: 0 } : { big: 0, fast: mixShare };
    }

    const bigPortion = Math.random();
    return { big: mixShare * bigPortion, fast: mixShare * (1 - bigPortion) };
  }

  /**
   * Во сколько раз крепче противники этой волны по сравнению с первой:
   * 1, 1.2, 1.44, … (CONFIG.run.waveHpGrowth).
   *
   * Применяется НА СПАВНЕ, в EnemyPool.spawn и Boss.spawn, и запоминается в
   * максимуме конкретного противника. Иначе смена волны меняла бы полоски уже
   * вышедших зомби: доля hp/max поехала бы у всех живых разом.
   */
  get hpMultiplier(): number {
    return CONFIG.run.waveHpGrowth ** (this.wave - 1);
  }

  /**
   * Во сколько раз больнее бьют противники этой волны по сравнению с первой
   * (CONFIG.run.waveDamageGrowth).
   *
   * Тоже берётся НА СПАВНЕ и запоминается у противника: зомби, доживший до
   * следующей волны, бьёт с силой СВОЕЙ волны, а не текущей. Иначе смена волны
   * усиливала бы уже стоящую у отряда толпу задним числом.
   */
  get damageMultiplier(): number {
    return CONFIG.run.waveDamageGrowth ** (this.wave - 1);
  }

  /**
   * Во сколько раз дороже кристалл этой волны по сравнению с первой:
   * 1, 1.5, 2.25, … (CONFIG.run.waveExpGrowth).
   *
   * Берётся НА ВЫПАДЕНИИ кристалла (CrystalPool.spawn), а не на подборе, и по
   * той же причине, что hp/damage берутся на спавне: награда принадлежит той
   * волне, в которой её заслужили. У босса это не тонкость, а необходимость —
   * он умирает последним в волне, startNextWave срабатывает на следующем кадре,
   * и на подборе его кристаллы уже считались бы кристаллами новой волны.
   *
   * С множителем прокачки (player.expMultiplier) не пересекается: тот один раз
   * применяется к итогу забега, см. expEarned.
   */
  get expMultiplier(): number {
    return CONFIG.run.waveExpGrowth ** (this.wave - 1);
  }

  private resetWaveBudget(): void {
    // Единиц в волне ровно столько при ЛЮБОМ составе: сначала считается общий
    // бюджет, и только потом он делится на виды. Иначе доля крупных меняла бы
    // длительность волны, хотя обязана менять только её состав.
    const total = Math.round(CONFIG.run.waveZombieCount * this.budgetMultiplier);

    // Крупные и быстрые входят в бюджет не раньше своих волн (bigZombieFromWave /
    // fastZombieFromWave), а до них их доля ОТДАЁТСЯ ОБЫЧНЫМ, а не пропадает:
    // число единиц в волне одинаково при любом составе, поэтому ранняя волна не
    // оказывается короче прочих просто из-за того, что в ней нет этих видов.
    const mix = this.rollWaveMix();
    this.bigShareNow = mix.big;
    this.fastShareNow = mix.fast;
    const bigBudget = Math.round(total * mix.big);
    // Второе округление зажато остатком: при долях 0.5 + 0.5 два независимых
    // Math.round на нечётном бюджете дали бы на единицу больше total, и остаток
    // обычных ушёл бы в минус.
    const fastBudget = Math.min(Math.round(total * mix.fast), total - bigBudget);
    this.normalLeft = total - bigBudget - fastBudget;
    this.bigLeft = bigBudget;
    this.fastLeft = fastBudget;
    // Итог волны запоминается, а не пересчитывается: полоса волны и бюджет спавна
    // обязаны совпадать, а два независимых округления могли бы разойтись.
    this.waveTotal =
      this.normalLeft + this.bigLeft + this.fastLeft + (CONFIG.run.hasBoss ? 1 : 0);
    this.killed = 0;
    this.bossKilled = false;
  }

  /**
   * Сколько секунд идёт забег. По этому времени EnemyPool разгоняет плотность
   * спавна: вначале зомби мало, к концу волны — плотная толпа.
   *
   * Здесь только факт о забеге; сам расчёт интервала живёт у своего единственного
   * потребителя, в EnemyPool.
   */
  get elapsedSeconds(): number {
    return this.elapsed;
  }

  /**
   * Двигает часы забега и скорость мира. Вызывается игровым шагом длиной в кадр,
   * первым в Game.update: по часам считается разгон плотности, по скорости —
   * весь сдвиг мира на этом шаге.
   */
  advance(dt: number): void {
    this.elapsed += dt;
    this.easeWorldSpeed(dt);
  }

  /**
   * СКОРОСТЬ НАЕЗДА МИРА прямо сейчас, units/сек. Её читают все, кого везёт
   * дорога: декор, зомби и тела, бочки, ворота, мины, выходящий босс.
   *
   * Живёт в RunState, а не в World, потому что World видит только себя, а
   * RunState уже роздан почти всем перечисленным. Флаг у World плюс копия у
   * каждого поля — это несколько источников правды, и они разъехались бы при
   * первой правке.
   *
   * Кристаллы и монеты сюда НЕ входят намеренно: дорога их вообще не везёт — с
   * места выпадения они сразу уходят в счётчик за своё время (pickupFlight), и
   * на остановленном мире это выглядит так же, как на едущем. Застывший в
   * воздухе кристалл читался бы как поломка, а не как остановка мира.
   */
  get worldSpeed(): number {
    return this.worldSpeedNow;
  }

  /** Едет ли мир — цель, к которой стремится worldSpeed. */
  get worldMoving(): boolean {
    return this.worldMoves;
  }

  /**
   * Останавливает мир и запускает его обратно. Единственный вызывающий —
   * Game.updateBossPhase.
   *
   * Скорость меняется не рывком: фактическое значение доезжает до цели за
   * CONFIG.world.stopEaseSeconds, поэтому звать можно каждый кадр — повторный
   * вызов с тем же значением ничего не сбрасывает.
   */
  setWorldMoving(moving: boolean): void {
    this.worldMoves = moving;
  }

  /**
   * Разгон и торможение мира. Шаг считается от НОМИНАЛЬНОЙ скорости, а не от
   * оставшейся разницы: так замедление постоянное и остановка занимает ровно
   * stopEaseSeconds, тогда как «доля остатка за шаг» тянулась бы асимптотой и
   * зависела бы ещё и от длины кадра (dt здесь непостоянный, см. core/loop.ts).
   */
  private easeWorldSpeed(dt: number): void {
    const { worldSpeed, stopEaseSeconds } = CONFIG.world;
    const target = this.worldMoves ? worldSpeed : 0;

    if (stopEaseSeconds <= 0) {
      this.worldSpeedNow = target;
      return;
    }

    const step = (worldSpeed / stopEaseSeconds) * dt;
    this.worldSpeedNow =
      this.worldSpeedNow < target
        ? Math.min(this.worldSpeedNow + step, target)
        : Math.max(this.worldSpeedNow - step, target);
  }

  /**
   * Разрешена ли вещь, открывающаяся на секунде atSeconds (CONFIG.run.unlocks).
   *
   * Разблокировка снимает запрет, но ничего не гарантирует: появление остаётся
   * случайным, просто до срока оно невозможно.
   */
  isUnlocked(atSeconds: number): boolean {
    return this.elapsed >= atSeconds;
  }

  /**
   * Всего единиц в ТЕКУЩЕЙ волне: обычные + крупные + босс. Растёт от волны к
   * волне вместе с бюджетом (CONFIG.run.waveBudgetGrowth).
   */
  get totalZombies(): number {
    return this.waveTotal;
  }

  /** Сколько зомби осталось в текущей волне — это и есть число на полосе волны. */
  get remainingZombies(): number {
    return Math.max(0, this.totalZombies - this.killed);
  }

  get killedZombies(): number {
    return this.killed;
  }

  /**
   * Накопленный за забег опыт БЕЗ множителя прокачки — ровно столько кристаллов
   * подобрано. Это и есть число в HUD: счётчик во время забега показывает
   * «сколько собрано», а не «сколько за это дадут».
   */
  get exp(): number {
    return this.expTotal;
  }

  /**
   * Сколько опыта забег отдаст в банк: собранное × множитель прокачки.
   *
   * Множитель применяется ОДИН РАЗ здесь, а не на каждом кристалле. Разница
   * не в арифметике (она та же), а в том, что видит игрок: счётчик в HUD растёт
   * на честную единицу за кристалл, а прибавка от прокачки читается разом на
   * экране результата, где рядом и написано, откуда она взялась.
   */
  get expEarned(): number {
    return this.expTotal * CONFIG.player.expMultiplier;
  }

  /**
   * Собранные за забег деньги — валюта магазина оружия (CONFIG.shop).
   *
   * Всегда целые: находка округляется на выпадении (MoneyPool.dropFrom).
   * Множителя прокачки здесь нет — это то самое число, что стояло в HUD.
   */
  get money(): number {
    return this.moneyTotal;
  }

  /**
   * Сколько денег забег отдаст в банк: собранное × множитель прокачки.
   *
   * Устроено ровно как expEarned, и по той же причине (см. его комментарий):
   * множитель применяется ОДИН РАЗ здесь, а не на каждой монете. Округление
   * вниз — банк целочисленный, а вверх дало бы монету из воздуха на пустом забеге.
   */
  get moneyEarned(): number {
    return Math.floor(this.moneyTotal * CONFIG.player.moneyMultiplier);
  }

  /** Начисляет деньги с подобранной монеты. Единственная точка. */
  addMoney(amount: number): void {
    if (amount <= 0) return;
    this.moneyTotal += amount;
  }

  /** Череп на полосе: в конце волны будет босс. */
  get hasBoss(): boolean {
    return CONFIG.run.hasBoss;
  }

  /** Бюджет обычных зомби исчерпан — дальше только босс (слой 10). */
  get allZombiesSpawned(): boolean {
    return this.normalLeft <= 0 && this.bigLeft <= 0 && this.fastLeft <= 0;
  }

  get bossDefeated(): boolean {
    return this.bossKilled;
  }

  /**
   * Берёт следующего зомби из бюджета. null — спавнить больше некого.
   *
   * Вид выбирается пропорционально остаткам, а не по фиксированному шансу:
   * тогда крупные равномерно рассеяны по всему забегу и не сваливаются в конец.
   */
  takeNextZombie(): ZombieKind | null {
    // Никаких запретов по ходу волны здесь НЕТ, и это важно: состав бюджета
    // определяется один раз, в resetWaveBudget. Раньше крупные держались замком до
    // 120-й секунды забега, и волна распадалась надвое — сначала ~270 обычных, а
    // потом, когда обычные кончались и замок уступал, толпа из 30 крупных подряд.
    // Гейт переехал на номер волны именно поэтому: внутри волны запирать нечего.
    const total = this.normalLeft + this.bigLeft + this.fastLeft;
    if (total <= 0) return null;

    const pick = Math.random() * total;
    if (pick < this.normalLeft) {
      this.normalLeft--;
      return 'normal';
    }

    if (pick < this.normalLeft + this.bigLeft) {
      this.bigLeft--;
      return 'big';
    }

    this.fastLeft--;
    return 'fast';
  }

  registerZombieKill(): void {
    this.killed++;
  }

  registerBossKill(): void {
    if (this.bossKilled) return;
    this.bossKilled = true;
    this.killed++;
  }

  /**
   * Начисляет опыт. Единственная точка, через которую EXP попадает в забег.
   *
   * Множитель прокачки здесь НЕ применяется — он висит на expEarned и срабатывает
   * один раз, когда забег кончился. Раньше умножалось здесь, и счётчик в HUD рос
   * дробными шагами непонятного размера; теперь во время забега видно ровно то,
   * что подобрано, а прокачка проявляется на экране результата.
   *
   * Сумма всё равно может быть дробной (кристалл ×1.5), на экран выводится
   * Math.floor, а цены сравниваются с точным значением: округление на каждом
   * кристалле незаметно съедало бы прогресс.
   */
  addExp(amount: number): void {
    this.expTotal += amount;
  }

  /** Состояние забега — для отладки и проверок. */
  debugSnapshot(): {
    total: number;
    remaining: number;
    killed: number;
    normalLeft: number;
    bigLeft: number;
    fastLeft: number;
    bigShare: number;
    fastShare: number;
    exp: number;
    expEarned: number;
    money: number;
    moneyEarned: number;
    hasBoss: boolean;
    elapsed: number;
    wave: number;
    worldMoving: boolean;
    worldSpeed: number;
    spawnRateMultiplier: number;
    hpMultiplier: number;
    damageMultiplier: number;
    expMultiplier: number;
  } {
    return {
      total: this.totalZombies,
      remaining: this.remainingZombies,
      killed: this.killed,
      normalLeft: this.normalLeft,
      bigLeft: this.bigLeft,
      fastLeft: this.fastLeft,
      bigShare: +this.bigShare.toFixed(3),
      fastShare: +this.fastShare.toFixed(3),
      exp: this.expTotal,
      expEarned: +this.expEarned.toFixed(2),
      money: this.moneyTotal,
      moneyEarned: this.moneyEarned,
      hasBoss: this.hasBoss,
      elapsed: +this.elapsed.toFixed(2),
      wave: this.wave,
      // Мир: цель и фактическая скорость. На боссфайте оба уходят в ноль.
      worldMoving: this.worldMoves,
      worldSpeed: +this.worldSpeedNow.toFixed(3),
      spawnRateMultiplier: +this.spawnRateMultiplier.toFixed(3),
      hpMultiplier: +this.hpMultiplier.toFixed(3),
      damageMultiplier: +this.damageMultiplier.toFixed(3),
      expMultiplier: +this.expMultiplier.toFixed(3),
    };
  }
}
