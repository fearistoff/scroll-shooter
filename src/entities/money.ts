import { CylinderGeometry, Vector3, type Scene } from 'three';
import { CONFIG } from '../config';
import { PickupPool, type PickupMotion } from './pickups';

/** С кого выпали деньги — от этого зависит только размер находки. */
export type MoneySource = 'normal' | 'big' | 'fast' | 'boss';

/**
 * Монеты (деньги) — валюта магазина оружия (CONFIG.shop).
 *
 * Падают ТОЛЬКО с убитых зомби и только с вероятностью money.dropChance:
 * с бочек, ворот и мин денег нет. Дальше ведут себя как кристаллы EXP —
 * едут к отряду и собираются на его линии (общий PickupPool).
 *
 * ВЫПАДЕНИЕ — В ОДНОЙ ВОРОНКЕ, dropFrom. И зомби, и босс зовут именно её,
 * поэтому бросок вероятности и диапазоны лежат в одном месте: два независимых
 * `Math.random() < 0.3` рано или поздно разъехались бы, как это уже бывало с
 * присвоением HP до появления воронок урона.
 */
export class MoneyPool extends PickupPool {
  /** Сколько денег выпало за забег — по нему меряется доходность. */
  private valueDropped = 0;

  constructor(scene: Scene) {
    const { coin, poolSize } = CONFIG.money;

    // Цилиндр повёрнут осью вдоль Z: плоские стороны смотрят на камеру, и
    // монета стоит на ребре, а не лежит на дороге плашмя.
    const geometry = new CylinderGeometry(coin.radius, coin.radius, coin.height, coin.segments);
    geometry.rotateX(Math.PI / 2);

    super(scene, {
      geometry,
      color: coin.color,
      poolSize,
      // Вокруг вертикали: монета поворачивается к камере то лицом, то ребром.
      spinAxis: new Vector3(0, 1, 0),
    });
  }

  protected get motion(): PickupMotion {
    return CONFIG.money;
  }

  /** Сколько денег выпало за забег (не обязательно собрано). */
  get dropped(): number {
    return this.valueDropped;
  }

  /**
   * Единственная точка, из которой деньги попадают на дорогу.
   *
   * scale множит находку — им пользуется только босс, чтобы награда росла тем же
   * темпом, что и его запас прочности (run.hpMultiplier). У обычных и крупных
   * зомби scale всегда 1, см. CONFIG.money.bossScalesWithHp.
   *
   * Множителя прокачки (player.moneyMultiplier) здесь НЕТ: он применяется один
   * раз на выходе из забега, в RunState.moneyEarned — как и множитель опыта.
   * Так счётчик в HUD растёт на честную находку, а прибавка от прокачки читается
   * разом на экране результата, где рядом написано, из чего она получилась.
   * Пер-монетное умножение с округлением каждой находки такой строки не давало:
   * сумма округлений не равнялась сумме, умноженной на множитель.
   *
   * Возвращает выпавшую сумму; 0 — бросок не прошёл. Возврат нужен замерочным
   * скриптам: по нему считается фактическая доходность забега.
   */
  dropFrom(x: number, z: number, source: MoneySource, scale = 1): number {
    const config = CONFIG.money;
    if (Math.random() >= config.dropChance) return 0;

    const range =
      source === 'boss'
        ? config.perBoss
        : source === 'big'
          ? config.perBigZombie
          : source === 'fast'
            ? config.perFastZombie
            : config.perNormalZombie;

    const min = range[0] ?? 1;
    const max = range[1] ?? min;
    const rolled = min + Math.floor(Math.random() * (max - min + 1));
    // scale дробный (у босса 1.2^(волна−1)), поэтому округление после него.
    const amount = Math.max(1, Math.round(rolled * scale));

    this.spawn(x, z, amount);
    this.valueDropped += amount;
    return amount;
  }

  /**
   * Находка ТОЧНОЙ суммы, без броска вероятности и без диапазонов.
   *
   * Зовёт её только снятая полоса HP босса (CONFIG.money.perBossLayer): это не
   * находка с трупа, а награда за пройденный этап боя, поэтому и разброса у неё
   * нет — сумма обещана игроку полосой на экране. Через dropFrom это выразить
   * нельзя: там и шанс 30%, и случайный диапазон.
   *
   * Счётчик выпавшего за забег общий с dropFrom — доходность меряется по нему.
   */
  dropExact(x: number, z: number, amount: number): number {
    const value = Math.max(1, Math.round(amount));
    this.spawn(x, z, value);
    this.valueDropped += value;
    return value;
  }

  override reset(): void {
    super.reset();
    this.valueDropped = 0;
  }
}
