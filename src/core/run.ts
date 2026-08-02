import { CONFIG } from '../config';

/** Кого спавнить следующим. */
export type ZombieKind = 'normal' | 'big';

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
  private killed = 0;
  private expTotal = 0;
  private moneyTotal = 0;
  private bossKilled = false;
  private elapsed = 0;
  private wave = 1;
  /** Итог текущей волны для полосы: обычные + крупные + босс. */
  private waveTotal = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.expTotal = 0;
    this.moneyTotal = 0;
    this.elapsed = 0;
    this.wave = 1;
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
   * Какая ДОЛЯ бюджета этой волны — крупные зомби: 0 до bigZombieFromWave, дальше
   * по bigZombieShareStep за волну (волна 2 — 10%, волна 3 — 20%, …) до
   * bigZombieShareMax.
   *
   * Рост линейный, а не кумулятивный (см. CONFIG.run.bigZombieShareStep), и это
   * доля от ОБЩЕГО числа единиц волны — состав меняется, количество нет.
   */
  get bigShare(): number {
    const { bigZombieFromWave, bigZombieShareStep, bigZombieShareMax } = CONFIG.run;
    if (this.wave < bigZombieFromWave) return 0;
    const steps = this.wave - bigZombieFromWave + 1;
    return Math.min(bigZombieShareMax, bigZombieShareStep * steps);
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

  private resetWaveBudget(): void {
    // Единиц в волне ровно столько при ЛЮБОМ составе: сначала считается общий
    // бюджет, и только потом он делится на виды. Иначе доля крупных меняла бы
    // длительность волны, хотя обязана менять только её состав.
    const total = Math.round(CONFIG.run.waveZombieCount * this.budgetMultiplier);

    // Крупные входят в бюджет не раньше своей волны (CONFIG.run.bigZombieFromWave),
    // а до неё их доля ОТДАЁТСЯ ОБЫЧНЫМ, а не пропадает: число единиц в волне
    // одинаково при любом составе, поэтому ранняя волна не оказывается короче
    // прочих просто из-за того, что в ней нет крупных.
    const bigBudget = Math.round(total * this.bigShare);
    this.normalLeft = total - bigBudget;
    this.bigLeft = bigBudget;
    // Итог волны запоминается, а не пересчитывается: полоса волны и бюджет спавна
    // обязаны совпадать, а два независимых округления могли бы разойтись.
    this.waveTotal = this.normalLeft + this.bigLeft + (CONFIG.run.hasBoss ? 1 : 0);
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

  /** Двигает часы забега. Вызывается игровым шагом длиной в кадр. */
  advance(dt: number): void {
    this.elapsed += dt;
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
   * Всегда целые: находка округляется на выпадении (MoneyPool.dropFrom), там же
   * применён и множитель прокачки (player.moneyMultiplier). Тем и отличается от
   * EXP: там сумма дробная, а множитель применяется один раз на выходе из
   * забега, поэтому число на экране результата больше того, что было в HUD.
   * У денег такого расхождения нет — сколько подобрано, столько и зачислено.
   */
  get money(): number {
    return this.moneyTotal;
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
    return this.normalLeft <= 0 && this.bigLeft <= 0;
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
    const total = this.normalLeft + this.bigLeft;
    if (total <= 0) return null;

    if (Math.random() * total < this.normalLeft) {
      this.normalLeft--;
      return 'normal';
    }

    this.bigLeft--;
    return 'big';
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
    bigShare: number;
    exp: number;
    expEarned: number;
    money: number;
    hasBoss: boolean;
    elapsed: number;
    wave: number;
    spawnRateMultiplier: number;
    hpMultiplier: number;
    damageMultiplier: number;
  } {
    return {
      total: this.totalZombies,
      remaining: this.remainingZombies,
      killed: this.killed,
      normalLeft: this.normalLeft,
      bigLeft: this.bigLeft,
      bigShare: +this.bigShare.toFixed(3),
      exp: this.expTotal,
      expEarned: +this.expEarned.toFixed(2),
      money: this.moneyTotal,
      hasBoss: this.hasBoss,
      elapsed: +this.elapsed.toFixed(2),
      wave: this.wave,
      spawnRateMultiplier: +this.spawnRateMultiplier.toFixed(3),
      hpMultiplier: +this.hpMultiplier.toFixed(3),
      damageMultiplier: +this.damageMultiplier.toFixed(3),
    };
  }
}
