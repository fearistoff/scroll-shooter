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

  private resetWaveBudget(): void {
    const growth = this.budgetMultiplier;
    // Округляем каждый вид отдельно: иначе соотношение обычных к крупным
    // (88/12) уплывало бы с ростом волны.
    this.normalLeft = Math.round(CONFIG.run.normalZombieCount * growth);
    this.bigLeft = Math.round(CONFIG.run.bigZombieCount * growth);
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

  /** Двигает часы забега. Вызывается игровым шагом с фиксированным dt. */
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

  get exp(): number {
    return this.expTotal;
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
    // Крупные до своей секунды не выпускаются: их бюджет просто ждёт. Обычные
    // при этом расходуются как обычно, поэтому ранняя волна целиком из обычных.
    //
    // НО ЗАМОК УСТУПАЕТ, КОГДА ИНАЧЕ ВОЛНА ВСТАЁТ. Если обычные кончились, а
    // крупные ещё закрыты, выпускаем крупных досрочно. Без этого получалась дыра,
    // которую и видно на скриншоте: сильный отряд выбивал все 264 обычных к 65-й
    // секунде, а 36 крупных ждали 120-й — на дороге больше минуты не было НИКОГО,
    // полоса волны при этом показывала 37 оставшихся. Правило «не простаивать»
    // важнее правила «крупные не раньше двух минут»: разблокировка нужна, чтобы
    // крупные не встретились в первые секунды, а не чтобы игра замирала.
    const bigAllowed = this.isUnlocked(CONFIG.run.unlocks.bigZombie);
    const bigAvailable = bigAllowed || this.normalLeft <= 0 ? this.bigLeft : 0;

    const total = this.normalLeft + bigAvailable;
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
   * Начисляет опыт. Единственная точка, через которую EXP попадает в забег,
   * поэтому множитель прокачки применяется здесь: счётчик в HUD и сумма на
   * экране результата согласованы по определению, а любой будущий источник
   * опыта получит множитель автоматически.
   *
   * Сумма дробная (кристалл ×1.5), на экран выводится Math.floor, а цены
   * сравниваются с точным значением: округление на каждом кристалле незаметно
   * съедало бы прогресс.
   */
  addExp(amount: number): void {
    this.expTotal += amount * CONFIG.player.expMultiplier;
  }

  /** Состояние забега — для отладки и проверок. */
  debugSnapshot(): {
    total: number;
    remaining: number;
    killed: number;
    normalLeft: number;
    bigLeft: number;
    exp: number;
    hasBoss: boolean;
    elapsed: number;
    wave: number;
    spawnRateMultiplier: number;
  } {
    return {
      total: this.totalZombies,
      remaining: this.remainingZombies,
      killed: this.killed,
      normalLeft: this.normalLeft,
      bigLeft: this.bigLeft,
      exp: this.expTotal,
      hasBoss: this.hasBoss,
      elapsed: +this.elapsed.toFixed(2),
      wave: this.wave,
      spawnRateMultiplier: +this.spawnRateMultiplier.toFixed(3),
    };
  }
}
