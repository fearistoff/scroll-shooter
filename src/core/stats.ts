import { CONFIG } from '../config';

/**
 * Итог одной вылазки — всё, что статистика забирает из забега.
 *
 * Снимок, а не ссылки на подсистемы: считается он ровно один раз, в
 * Game.finishRun, и после смерти героя подсистемы уже сбрасываются.
 *
 * Боссы отдельным полем не приходят: убитый босс — это переход к следующей
 * волне, поэтому их число в забеге есть wave − startWave (см. GlobalStats.record).
 */
export interface RunRecord {
  /** Волна, на которой забег закончился. */
  wave: number;
  /** Волна, с которой он начался: оплаченный бустером старт сдвигает её. */
  startWave: number;
  elapsedSeconds: number;
  /** Убито зомби, без боссов (EnemyPool.killed). */
  killedZombies: number;
  brokenBarrels: number;
  /** Зачислено в банки — с множителями прокачки и бустеров, как на результате. */
  earnedExp: number;
  earnedMoney: number;
}

/**
 * Что лежит в localStorage. Поля плоские и все числовые: читаются одним
 * помощником (readNumber), и добавление нового поля не требует ничего, кроме
 * строки здесь и строки в load.
 */
interface SavedStats {
  runs: number;
  /** Суммарное время всех вылазок, секунды. */
  seconds: number;
  /** Самая долгая вылазка, секунды. */
  bestSeconds: number;
  /** Самая дальняя волна за всё время. Дублирует рекорд прогресса намеренно —
   *  см. GlobalStats.bestWave. */
  bestWave: number;
  bosses: number;
  zombies: number;
  barrels: number;
  /** Заработано за всё время, суммой зачислений в банк. */
  exp: number;
  money: number;
  /** Лучшая добыча за одну вылазку. */
  bestExp: number;
  bestMoney: number;
}

/** Пустая статистика: значения по умолчанию и заодно образец для чтения. */
const EMPTY: SavedStats = {
  runs: 0,
  seconds: 0,
  bestSeconds: 0,
  bestWave: 0,
  bosses: 0,
  zombies: 0,
  barrels: 0,
  exp: 0,
  money: 0,
  bestExp: 0,
  bestMoney: 0,
};

/**
 * Число из чужого JSON: отрицательные, дробные мусорные и не-числа приводятся к
 * нулю или к умолчанию. Битая статистика не должна ломать экран, на который
 * заходят между забегами.
 */
function readNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * Глобальная статистика за всё время: сколько вылазок сделано, как далеко и
 * долго они шли, сколько по итогу убито и заработано.
 *
 * Отдельный от MetaProgress класс и отдельный ключ localStorage: на игру она не
 * влияет вовсе — ни на цены, ни на замки, ни на числа отряда, — и знать о ней
 * подсистемам незачем. Пишется ровно в одной точке (Game.finishRun) и читается
 * ровно в одной (экран статистики), поэтому «влезть» в неё по ходу забега
 * нельзя даже случайно.
 *
 * Копится только то, что суммируется или бьёт рекорд. Средние значения (время
 * вылазки, добыча) не хранятся, а считаются геттерами: сумма и число вылазок
 * уже есть, а хранимое среднее пришлось бы пересчитывать и оно бы разъезжалось
 * с ними при первой же правке.
 */
export class GlobalStats {
  private data: SavedStats = { ...EMPTY };

  constructor() {
    this.load();
  }

  /** Была ли хоть одна вылазка. По нему экран прокачки прячет кнопку статистики. */
  get hasRuns(): boolean {
    return this.data.runs > 0;
  }

  get runs(): number {
    return this.data.runs;
  }

  get totalSeconds(): number {
    return this.data.seconds;
  }

  get bestSeconds(): number {
    return this.data.bestSeconds;
  }

  /** Средняя длительность вылазки. Без вылазок — 0, а не деление на ноль. */
  get averageSeconds(): number {
    return this.data.runs > 0 ? this.data.seconds / this.data.runs : 0;
  }

  /**
   * Самая дальняя волна.
   *
   * Своё поле, хотя такой же рекорд ведёт MetaProgress.registerWave: там он
   * снимает замки магазина и потому обязан жить в прогрессе, а здесь читается
   * вместе с остальными числами вылазок. Расходиться им не с чего — обновляются
   * оба в Game.finishRun, — а сброс прогресса чистит и то, и другое.
   */
  get bestWave(): number {
    return this.data.bestWave;
  }

  get bosses(): number {
    return this.data.bosses;
  }

  get zombies(): number {
    return this.data.zombies;
  }

  get barrels(): number {
    return this.data.barrels;
  }

  get exp(): number {
    return this.data.exp;
  }

  get money(): number {
    return this.data.money;
  }

  get bestExp(): number {
    return this.data.bestExp;
  }

  get bestMoney(): number {
    return this.data.bestMoney;
  }

  /** Средняя добыча опыта за вылазку — как averageSeconds. */
  get averageExp(): number {
    return this.data.runs > 0 ? this.data.exp / this.data.runs : 0;
  }

  get averageMoney(): number {
    return this.data.runs > 0 ? this.data.money / this.data.runs : 0;
  }

  /**
   * Учитывает завершённую вылазку. Единственная точка записи.
   *
   * Боссы считаются как пройденные волны (wave − startWave): волну заканчивает
   * только смерть босса, а старт с поздней волны боссов не дарит — иначе
   * оплаченный бустером старт с 5-й волны записывал бы четыре чужие победы.
   */
  record(run: RunRecord): void {
    const data = this.data;

    data.runs += 1;
    data.seconds += Math.max(0, run.elapsedSeconds);
    data.bestSeconds = Math.max(data.bestSeconds, run.elapsedSeconds);
    data.bestWave = Math.max(data.bestWave, run.wave);
    data.bosses += Math.max(0, run.wave - run.startWave);
    data.zombies += Math.max(0, run.killedZombies);
    data.barrels += Math.max(0, run.brokenBarrels);
    data.exp += Math.max(0, run.earnedExp);
    data.money += Math.max(0, run.earnedMoney);
    data.bestExp = Math.max(data.bestExp, run.earnedExp);
    data.bestMoney = Math.max(data.bestMoney, run.earnedMoney);

    this.save();
  }

  /**
   * Стирает статистику. Зовётся вместе с MetaProgress.reset() из кнопки сброса
   * на экране прокачки: сброс обещает начать как в первый раз, а оставленный
   * счётчик вылазок говорил бы обратное.
   */
  reset(): void {
    this.data = { ...EMPTY };
    this.save();
  }

  /**
   * Чтение. Любое отклонение от ожидаемого — поле остаётся нулевым: статистика
   * ни на что не влияет, и восстанавливать по ней нечего.
   */
  private load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(CONFIG.meta.statsKey);
    } catch {
      // localStorage недоступен (приватный режим, отключён политикой).
      return;
    }
    if (raw === null) return;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;

      const saved = parsed as Partial<Record<keyof SavedStats, unknown>>;
      const data = { ...EMPTY };
      for (const key of Object.keys(EMPTY) as Array<keyof SavedStats>) {
        data[key] = readNumber(saved[key], EMPTY[key]);
      }
      // Целые счётчики — целыми: дробное число вылазок или убитых зомби могло
      // прийти только правкой руками, и в подписи оно выглядело бы поломкой.
      // EXP дробный намеренно, как банк прокачки: множитель опыта даёт нецелые
      // кристаллы, и округление на входе теряло бы часть суммы.
      data.runs = Math.floor(data.runs);
      data.bestWave = Math.floor(data.bestWave);
      data.bosses = Math.floor(data.bosses);
      data.zombies = Math.floor(data.zombies);
      data.barrels = Math.floor(data.barrels);
      data.money = Math.floor(data.money);
      data.bestMoney = Math.floor(data.bestMoney);

      this.data = data;
    } catch {
      // Невалидный JSON — статистика начинается с нуля.
      this.data = { ...EMPTY };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(CONFIG.meta.statsKey, JSON.stringify(this.data));
    } catch {
      // Нет места или доступа — статистика останется в памяти сессии.
    }
  }

  /** Состояние — для отладки и замерочных скриптов (__game.stats). */
  debugSnapshot(): SavedStats & { averageSeconds: number; averageExp: number } {
    return {
      ...this.data,
      exp: +this.data.exp.toFixed(2),
      bestExp: +this.data.bestExp.toFixed(2),
      seconds: +this.data.seconds.toFixed(2),
      bestSeconds: +this.data.bestSeconds.toFixed(2),
      averageSeconds: +this.averageSeconds.toFixed(2),
      averageExp: +this.averageExp.toFixed(2),
    };
  }
}
