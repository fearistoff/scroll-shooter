// Текст файла попадает в бандл строкой (?raw) и разбирается один раз при загрузке
// модуля. Именно исходный markdown, а не сгенерированный на сборке модуль: файл
// правится руками и читается в репозитории как обычный CHANGELOG, а игре нужен
// ровно тот же список — двух источников быть не должно.
import source from '../../CHANGELOG.md?raw';

/** Одна выпущенная версия: номер, дата и что в ней изменилось для игрока. */
export interface ChangelogEntry {
  /** Ровно то, что стояло в package.json у этой сборки. */
  version: string;
  /** Дата выпуска в ISO (YYYY-MM-DD) — форматируется при показе. */
  date: string;
  /** Изменения, заметные игроку. Внутренние правки сюда не попадают. */
  changes: readonly string[];
}

/**
 * Заголовок версии: `## 2.8.3 — 2026-08-03`.
 *
 * Разделитель принимается любой из трёх (длинное тире, короткое, дефис) — при
 * ручной правке файла они путаются, а различать их незачем. Номер версии
 * ограничен цифрами и точками, поэтому жадность не съедает дату.
 */
const HEADING = /^##\s+v?([\d.]+)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** Пункт списка изменений: `- текст` или `* текст`. */
const BULLET = /^[-*]\s+(.+?)\s*$/;

/**
 * Разбирает CHANGELOG.md в список версий.
 *
 * Всё, что не заголовок версии и не пункт списка под ним, пропускается: в файле
 * есть и шапка с описанием формата, и пустые строки. Пункты до первого
 * заголовка (маркированный список в шапке) отбрасываются — им некуда лечь.
 */
function parse(markdown: string): ChangelogEntry[] {
  // Пункты дописываются в уже добавленную запись, поэтому changes здесь именно
  // изменяемый массив; наружу тот же объект уходит под readonly-типом.
  const entries: { version: string; date: string; changes: string[] }[] = [];

  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const [, version, date] = heading;
      if (version !== undefined && date !== undefined) entries.push({ version, date, changes: [] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const current = entries[entries.length - 1];
    if (bullet?.[1] !== undefined && current !== undefined) current.changes.push(bullet[1]);
  }

  return entries;
}

/**
 * История версий, от новой к старой.
 *
 * Источник — [CHANGELOG.md](../../CHANGELOG.md) в корне репозитория: он пишется
 * руками, а не собирается из git — в истории коммитов лежат и правки без
 * последствий для игрока, и переформулировки README, а на экране должно быть
 * только то, что игрок способен заметить в бою.
 *
 * ВАЖНО: поднимая version в package.json, добавляйте запись в CHANGELOG.md тем
 * же коммитом. Иначе в игре версия есть, а строки о ней нет.
 */
export const CHANGELOG: readonly ChangelogEntry[] = parse(source);

/**
 * Сокращённые месяцы в родительном падеже: строка читается как «3 авг. 2026».
 * Полные названия в узкую строку заголовка не влезают рядом с номером версии.
 */
const MONTHS: readonly string[] = [
  'янв.',
  'фев.',
  'мар.',
  'апр.',
  'мая',
  'июн.',
  'июл.',
  'авг.',
  'сен.',
  'окт.',
  'нояб.',
  'дек.',
];

/**
 * ISO-дата в человеческий вид.
 *
 * Строка разбирается посимвольно, а не через Date: `new Date('2026-08-03')`
 * читается как полночь UTC, и восточнее Гринвича день сдвигался бы на
 * следующий, а западнее — на предыдущий.
 */
export function formatChangelogDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  const monthName = MONTHS[Number(month) - 1];
  if (year === undefined || day === undefined || monthName === undefined) return iso;
  return `${Number(day)} ${monthName} ${year}`;
}
