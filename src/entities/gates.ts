import { BoxGeometry, Mesh, MeshStandardMaterial, type Scene } from 'three';
import { CONFIG } from '../config';
import { segmentHitsSlab } from '../core/collision';
import type { RunState } from '../core/run';
import type { BonusSlot } from './bonusSlot';

/** Тип ворот (ТЗ раздел 8). */
export type GateKind = 'A' | 'B';

/** Отряд с точки зрения ворот. */
export interface GateTarget {
  /** Позиция главного героя по x: тип A применяет ТОЛЬКО его секцию. */
  readonly x: number;
  /** Глубина строя по z — до какого z турникет ещё «проходят» бойцы. */
  readonly formationDepth: number;
  addShooters(count: number): void;
  /** Убирает доп. стрелков. Главного героя не трогает. */
  removeShooters(count: number): number;
  /** Есть ли хоть один стрелок в полосе [xMin, xMax] — для типа B. */
  hasShooterInRange(xMin: number, xMax: number): boolean;
}

/**
 * Ворота-множители обоих типов (ТЗ раздел 8).
 *
 * Обе разновидности хранятся в одном пуле как «части»: секция стены типа A или
 * отдельный турникет колонны типа B. Части одной стены делят groupId и одну
 * координату z; турникеты колонны стоят на разных z.
 *
 * РАЗНИЦА В ПОВЕДЕНИИ, из-за которой это один класс, а не два:
 *   тип A — пули стену останавливают и растят значение секции; применяется
 *           только секция, через которую прошёл ГЛАВНЫЙ герой;
 *   тип B — пули проходят насквозь, значение неизменно; прибавку применяет
 *           ЛЮБОЙ прошедший стрелок, и каждый турникет колонны даёт до +N.
 *
 * И то и другое ОДНОРАЗОВОЕ: часть исчезает в тот же шаг, в котором сработала.
 *
 * Пул — отдельные Mesh на единичном боксе со scale: частей единицы, зато у
 * каждой свои ширина и цвет.
 */
export class GateField {
  private readonly meshes: Mesh[] = [];
  private readonly materials: MeshStandardMaterial[] = [];

  private readonly kindIsB: Uint8Array;
  private readonly centerX: Float32Array;
  private readonly halfWidth: Float32Array;
  private readonly posZ: Float32Array;
  private readonly value: Float32Array;
  /** Индекс секции внутри стены — им выбирается цвет. */
  private readonly sectionIndex: Uint8Array;
  /**
   * Остаток кулдауна секции после засчитанного попадания. Пока больше нуля,
   * попадания гасят пулю, но значение не растят (CONFIG.gates.typeA.shootHitCooldown).
   */
  private readonly hitCooldown: Float32Array;

  private count = 0;
  private spawnTimer = 0;

  /** Во время боссфайта ворота не появляются (ТЗ раздел 10). */
  spawnEnabled = true;

  private appliedTotal = 0;
  private shotHitsTotal = 0;
  private lastAppliedValue = 0;

  constructor(
    scene: Scene,
    private readonly squad: GateTarget,
    private readonly run: RunState,
    private readonly bonusSlot: BonusSlot,
  ) {
    const { poolSize } = CONFIG.gates;

    // Единичный бокс: ширина и толщина задаются через scale, поэтому одна
    // геометрия обслуживает и широкие секции, и узкие турникеты.
    const geometry = new BoxGeometry(1, 1, 1);

    for (let i = 0; i < poolSize; i++) {
      const material = new MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(material);
    }

    this.kindIsB = new Uint8Array(poolSize);
    this.centerX = new Float32Array(poolSize);
    this.halfWidth = new Float32Array(poolSize);
    this.posZ = new Float32Array(poolSize);
    this.value = new Float32Array(poolSize);
    this.sectionIndex = new Uint8Array(poolSize);
    this.hitCooldown = new Float32Array(poolSize);
  }

  get activeCount(): number {
    return this.count;
  }

  get capacity(): number {
    return this.meshes.length;
  }

  /** Сколько частей уже применилось (для отладки и проверок). */
  get appliedCount(): number {
    return this.appliedTotal;
  }

  /** Сколько попаданий пуль зафиксировали секции типа A. */
  get shotHits(): number {
    return this.shotHitsTotal;
  }

  /** Значение последнего применённого прохода. */
  get lastApplied(): number {
    return this.lastAppliedValue;
  }

  // --- Спавн ---------------------------------------------------------------

  /**
   * Стена типа A: sectionCount секций подряд, суммарной ширины width.
   * centerOffsetX сдвигает стену по дороге, оставляя проезд с одной стороны.
   */
  spawnTypeA(centerOffsetX = 0, values?: number[]): void {
    const { sectionCount, width, negativeRange, positiveRange } = CONFIG.gates.typeA;
    const sectionWidth = width / sectionCount;
    const leftEdge = centerOffsetX - width / 2;

    for (let s = 0; s < sectionCount; s++) {
      if (this.count >= this.capacity) return;

      const i = this.count++;
      // Первая секция отрицательная, остальные положительные — как на 4.png.
      const fallback =
        s === 0
          ? GateField.randomInt(negativeRange[0] ?? -4, negativeRange[1] ?? -1)
          : GateField.randomInt(positiveRange[0] ?? 1, positiveRange[1] ?? 4);

      this.kindIsB[i] = 0;
      this.centerX[i] = leftEdge + sectionWidth * (s + 0.5);
      this.halfWidth[i] = sectionWidth / 2;
      this.posZ[i] = CONFIG.world.spawnZ;
      this.value[i] = values?.[s] ?? fallback;
      this.sectionIndex[i] = s;
      // Обязательно обнуляем: в слот мог попасть кулдаун предыдущей секции, и
      // новая стена вышла бы уже «остывающей».
      this.hitCooldown[i] = 0;
    }
  }

  /** Колонна турникетов типа B: count штук одна за другой по z. */
  spawnTypeB(centerOffsetX = 0, count?: number, valuePerGate?: number): void {
    const { countRange, spacingZ, valuePerGate: configValue, width } = CONFIG.gates.typeB;
    const total = count ?? GateField.randomInt(countRange[0] ?? 3, countRange[1] ?? 5);

    for (let g = 0; g < total; g++) {
      if (this.count >= this.capacity) return;

      const i = this.count++;
      this.kindIsB[i] = 1;
      this.centerX[i] = centerOffsetX;
      this.halfWidth[i] = width / 2;
      // Первый турникет ближе к отряду, остальные за ним.
      this.posZ[i] = CONFIG.world.spawnZ - g * spacingZ;
      this.value[i] = valuePerGate ?? configValue;
      this.sectionIndex[i] = 0;
      // Турникеты типа B стрельбой не растут, но слот общий — обнуляем и здесь.
      this.hitCooldown[i] = 0;
    }
  }

  private spawnStream(dt: number): void {
    const { interval, typeAChance, chance } = CONFIG.gates.spawn;
    if (!this.spawnEnabled || interval <= 0) return;

    this.spawnTimer += dt;

    // На экране допустим только один бонус (бочка или ворота). Пока он там, тик
    // не расходуется — таймер держим у порога, и ворота выходят в первый же кадр
    // после освобождения экрана. Одна стена или колонна — это один бонус: части
    // выезжают одним вызовом спавна, поэтому слот проверяется до него.
    if (!this.bonusSlot.isFree && this.spawnTimer > interval) this.spawnTimer = interval;

    // isFree в условии цикла, а не только перед ним: иначе накопленный таймер
    // выпустил бы за один кадр сразу две стены.
    while (this.spawnTimer >= interval && this.bonusSlot.isFree) {
      this.spawnTimer -= interval;

      // Каждый тик — только шанс, а не гарантия: так ворота вдвое реже прежнего
      // и промежутки между ними неровные.
      if (Math.random() >= chance) continue;

      const unlocks = CONFIG.run.unlocks;
      const typeAOk = this.run.isUnlocked(unlocks.gateTypeA);
      const typeBOk = this.run.isUnlocked(unlocks.gateTypeB);
      if (!typeAOk && !typeBOk) continue;

      // Ворота сдвинуты от центра: с одной стороны остаётся проезд мимо.
      const roadHalf = CONFIG.world.roadWidth / 2;
      const side = Math.random() < 0.5 ? -1 : 1;

      // Тип выбираем только из разблокированных: пока открыт один, выпадает он.
      const useTypeA = typeAOk && (!typeBOk || Math.random() < typeAChance);

      if (useTypeA) {
        const offset = side * (roadHalf - CONFIG.gates.typeA.width / 2);
        this.spawnTypeA(offset);
      } else {
        const offset = side * (roadHalf - CONFIG.gates.typeB.width / 2);
        this.spawnTypeB(offset);
      }
    }
  }

  // --- Обновление ----------------------------------------------------------

  update(dt: number): void {
    this.spawnStream(dt);

    const { despawnZ } = CONFIG.world;
    // Своей скорости у ворот нет, их везёт дорога: на боссфайте она стоит, и
    // недоехавшая створка дожидается конца боя на месте.
    const step = this.run.worldSpeed * dt;
    const heroX = this.squad.x;
    const formationDepth = this.squad.formationDepth;

    for (let i = 0; i < this.count; ) {
      // Кулдаун тает по игровому dt: на экранах игровой шаг не идёт, и стена там
      // не «остывает» на паузе.
      if (this.hitCooldown[i]! > 0) this.hitCooldown[i]! -= dt;

      const prevZ = this.posZ[i]!;
      this.posZ[i]! += step;
      const z = this.posZ[i]!;

      // Ворота одноразовые: отработавшая часть исчезает сразу, а не проезжает
      // дальше сквозь строй.
      const consumed =
        this.kindIsB[i] === 1
          ? this.updateTurnstile(i, formationDepth)
          : this.updateWallSection(i, prevZ, z, heroX);

      if (consumed || z > despawnZ) {
        this.recycle(i);
        continue;
      }

      this.render(i);
      i++;
    }

    for (let i = this.count; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
    }
  }

  /**
   * Секция стены типа A. Возвращает true, когда стена прошла линию героя и её
   * пора убрать.
   *
   * Значение применяет только та секция, в чьей полосе оказался ГЛАВНЫЙ герой.
   * Если герой в проезде мимо стены — не применяется ничего, что и требует ТЗ.
   */
  private updateWallSection(i: number, prevZ: number, z: number, heroX: number): boolean {
    // Линия героя — z = 0. Ловим именно пересечение, а не «за линией»:
    // иначе секция сработала бы повторно на следующем шаге.
    if (!(prevZ < 0 && z >= 0)) return false;

    const dx = heroX - this.centerX[i]!;
    if (Math.abs(dx) <= this.halfWidth[i]!) {
      this.applyValue(this.value[i]!);
    }

    return true;
  }

  /**
   * Турникет типа B. Срабатывает, если в его полосе оказался ЛЮБОЙ стрелок, и
   * тут же исчезает — турникет одноразовый. Стрелков не расходует.
   *
   * Возвращает true, если сработал и подлежит удалению.
   */
  private updateTurnstile(i: number, formationDepth: number): boolean {
    const halfThickness = CONFIG.gates.typeB.thickness / 2;
    // Окно прохода: от линии героя до последнего ряда строя.
    if (this.posZ[i]! < -halfThickness || this.posZ[i]! > formationDepth + halfThickness) {
      return false;
    }

    const xMin = this.centerX[i]! - this.halfWidth[i]!;
    const xMax = this.centerX[i]! + this.halfWidth[i]!;
    if (!this.squad.hasShooterInRange(xMin, xMax)) return false;

    this.applyValue(this.value[i]!);
    return true;
  }

  /** Плюс добавляет стрелков, минус убирает — только доп., героя не трогает. */
  private applyValue(value: number): void {
    const rounded = Math.round(value);
    if (rounded > 0) this.squad.addShooters(rounded);
    else if (rounded < 0) this.squad.removeShooters(-rounded);

    this.appliedTotal++;
    this.lastAppliedValue = rounded;
  }

  // --- Попадания пуль -------------------------------------------------------

  /**
   * Попадание пули (передаётся в BulletPool.update).
   *
   * Проверяются ТОЛЬКО секции типа A: они пулю останавливают и растут на
   * shootIncrement за попадание. Турникеты типа B по ТЗ простреливаются
   * насквозь и от стрельбы не меняются, поэтому в проверке не участвуют.
   *
   * После засчитанного попадания секция уходит в кулдаун на shootHitCooldown.
   * Попадания внутри него ГАСЯТСЯ (возвращаем true — стена физически держит
   * пулю), но значение не растят: иначе темп роста равнялся бы скорости огня
   * отряда, а не времени, которое игрок держит стену в прицеле.
   *
   * Пробивающий снаряд (огнемёт) здесь ничем не отличается: сквозь зомби, босса
   * и бочки пламя проходит, а стену типа A держит стена — она и остаётся
   * единственным, обо что пламя гаснет. Поэтому параметра pierce у этой проверки
   * нет, только фактическая ширина снаряда.
   */
  readonly tryHit = (
    xFrom: number,
    zFrom: number,
    xTo: number,
    zTo: number,
    _damage: number,
    bulletRadius: number = CONFIG.weapons.bullet.radius,
  ): boolean => {
    const { shootIncrement, thickness, shootHitCooldown } = CONFIG.gates.typeA;
    const halfThickness = thickness / 2;

    for (let i = 0; i < this.count; i++) {
      if (this.kindIsB[i] === 1) continue;

      if (
        !segmentHitsSlab(
          this.centerX[i]!,
          this.halfWidth[i]! + bulletRadius,
          this.posZ[i]!,
          halfThickness,
          xFrom,
          zFrom,
          xTo,
          zTo,
        )
      ) {
        continue;
      }

      // Пуля погашена в любом случае, но растит значение только вне кулдауна.
      if (this.hitCooldown[i]! > 0) return true;

      this.value[i]! += shootIncrement;
      this.hitCooldown[i] = shootHitCooldown;
      this.shotHitsTotal++;
      return true;
    }

    return false;
  };

  // --- Отрисовка и подписи --------------------------------------------------

  private render(i: number): void {
    const isB = this.kindIsB[i] === 1;
    const { height, thickness } = isB ? CONFIG.gates.typeB : CONFIG.gates.typeA;

    const mesh = this.meshes[i]!;
    mesh.visible = true;
    mesh.position.set(this.centerX[i]!, height / 2, this.posZ[i]!);
    mesh.scale.set(this.halfWidth[i]! * 2, height, thickness);

    const color = isB
      ? CONFIG.gates.typeB.color
      : (CONFIG.gates.typeA.colors[this.sectionIndex[i]!] ?? CONFIG.gates.typeA.colors[0]!);
    this.materials[i]!.color.setHex(color);
  }

  /** Перечисляет части для подписей: значение со знаком над воротами. */
  forEachLabel(
    visit: (x: number, y: number, z: number, value: string, icon: string, variant: string) => void,
  ): void {
    const { labelOffsetY } = CONFIG.gates;

    for (let i = 0; i < this.count; i++) {
      const isB = this.kindIsB[i] === 1;
      const height = isB ? CONFIG.gates.typeB.height : CONFIG.gates.typeA.height;
      const value = Math.round(this.value[i]!);

      visit(
        this.centerX[i]!,
        height + labelOffsetY,
        this.posZ[i]!,
        // Знак ставим явно: «+3» читается как бонус, «−3» как штраф.
        value < 0 ? `−${Math.abs(value)}` : `+${value}`,
        '',
        value < 0 ? 'gate-minus' : 'gate-plus',
      );
    }
  }

  private static randomInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /** Чистит поле и статистику забега. */
  reset(): void {
    this.count = 0;
    this.spawnTimer = 0;
    this.spawnEnabled = true;
    this.appliedTotal = 0;
    this.shotHitsTotal = 0;
    this.lastAppliedValue = 0;
    this.hitCooldown.fill(0);
    for (const mesh of this.meshes) mesh.visible = false;
  }

  private recycle(i: number): void {
    const last = this.count - 1;

    if (i !== last) {
      this.kindIsB[i] = this.kindIsB[last]!;
      this.centerX[i] = this.centerX[last]!;
      this.halfWidth[i] = this.halfWidth[last]!;
      this.posZ[i] = this.posZ[last]!;
      this.value[i] = this.value[last]!;
      this.sectionIndex[i] = this.sectionIndex[last]!;
      this.hitCooldown[i] = this.hitCooldown[last]!;
    }

    this.count--;
    this.meshes[this.count]!.visible = false;
  }

  /** Состояние ворот — для отладки и проверок. */
  debugSnapshot(): Array<{
    kind: GateKind;
    x: number;
    z: number;
    halfWidth: number;
    value: number;
    section: number;
  }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      out.push({
        kind: (this.kindIsB[i] === 1 ? 'B' : 'A') as GateKind,
        x: +this.centerX[i]!.toFixed(3),
        z: +this.posZ[i]!.toFixed(3),
        halfWidth: this.halfWidth[i]!,
        value: Math.round(this.value[i]!),
        section: this.sectionIndex[i]!,
      });
    }
    return out;
  }
}
