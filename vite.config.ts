import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const PUBLIC_DIR = 'public';
const SW_FILE = 'sw.js';

/**
 * Файлы из public/ путями относительно него самого.
 *
 * Скрытые файлы пропускаются намеренно. Это служебные маркеры хостинга
 * (.nojekyll для GitHub Pages), которые игре не нужны, а часть раздач их вообще
 * не отдаёт. Попади такой файл в предкеш — install воркера упал бы целиком:
 * cache.addAll отклоняется, если хоть один запрос неуспешен, и офлайна не было бы
 * вовсе. Проверено: без фильтра .nojekyll оказывался в списке.
 */
function listPublicFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join(posix.sep));
    }
  };
  try {
    walk(dir);
  } catch {
    // public/ может не существовать — тогда кешировать оттуда нечего.
  }
  return out.sort();
}

/**
 * Service worker с ПОЛНЫМ предкешированием: игра работает офлайн целиком.
 *
 * Список файлов собирается на сборке, а не пишется руками: имена ассетов
 * содержат хеш содержимого (index-COcD87DL.js) и меняются с каждой правкой, так
 * что зашитый список молча устарел бы после первого же билда.
 *
 * Воркбокс сюда не тащим: предкешировать нужно единицы файлов, вся логика
 * укладывается в несколько десятков строк, а зависимость пришлось бы обновлять.
 */
function precacheServiceWorker(): Plugin {
  return {
    name: 'precache-service-worker',
    apply: 'build',
    /*
     * Именно writeBundle, а не generateBundle: в Vite 8 index.html попадает в
     * bundle позже: на generateBundle там лежит только ["assets/index-*.js"], а
     * на writeBundle — уже и index.html. Проверено логом обоих хуков. Из-за этого
     * первая версия плагина собирала список без документа.
     *
     * Раз файлы к этому моменту записаны, sw.js пишем сами, а не emitFile.
     */
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (outDir === undefined) return;

      // Карты исходников в офлайн-кеш не нужны — это отладочный вес.
      const bundled = Object.keys(bundle).filter((name) => !name.endsWith('.map'));
      // public/ Vite копирует отдельно, в bundle этих файлов нет.
      const publicFiles = listPublicFiles(PUBLIC_DIR);
      const files = [...bundled, ...publicFiles];

      // './' — адрес самой навигации: по нему браузер просит документ, когда
      // игру открывают с домашнего экрана, и без него офлайн-старт не работает.
      const precache = ['./', ...files];

      // Версия кеша = хеш СОДЕРЖИМОГО всей сборки, а не только имён файлов.
      // Имена ассетов хешированы и списка бы хватило для них, но index.html,
      // манифест и иконки зовутся всегда одинаково: правка одной только разметки
      // или иконки оставила бы версию прежней, sw.js вышел бы байт-в-байт тем же,
      // браузер не увидел бы обновления и на устройстве остался бы старый кеш.
      // К этому моменту writeBundle всё уже записано, поэтому читаем из outDir —
      // и вывод сборки, и скопированный туда public/.
      const digest = createHash('sha256');
      digest.update(precache.join('\n'));
      for (const file of files) digest.update(readFileSync(join(outDir, file)));
      const version = digest.digest('hex').slice(0, 12);

      writeFileSync(join(outDir, SW_FILE), renderServiceWorker(version, precache));
    },
  };
}

function renderServiceWorker(version: string, precache: string[]): string {
  return `/*
 * Service worker игры. СГЕНЕРИРОВАН на сборке плагином precache-service-worker
 * из vite.config.ts — править здесь бессмысленно, файл перезапишется.
 *
 * Стратегия: документ — network-first, всё остальное — cache-first по
 * предкешированному списку. Внешних запросов у игры нет вообще (three.js в
 * бандле, шрифт системный, иконки локальные), поэтому полного предкеша
 * достаточно, чтобы играть офлайн.
 */
const CACHE = 'crowd-shooter-${version}';
const PRECACHE = ${JSON.stringify(precache, null, 2)};

// Сколько ждём документ из сети, прежде чем отдать копию из кеша. Сеть бывает не
// «есть или нет», а мёртвой при живом Wi-Fi: там fetch не отклоняется, а висит,
// и без предела запуск игры завис бы вместе с ним. Три секунды — заметная, но
// терпимая задержка на плохой связи; офлайн (мгновенный reject) её не ждёт.
const NAVIGATION_TIMEOUT_MS = 3000;

// Пути относительные: сборка живёт с base './' и может стоять в подпапке,
// поэтому всё разрешается от адреса самого воркера.
const url = (path) => new URL(path, self.location.href).href;

/*
 * ignoreVary ОБЯЗАТЕЛЕН, это не перестраховка.
 *
 * Раздача может присылать «Vary: Origin» (так делает vite preview, так делают
 * некоторые CDN). В предкеш ответ ложится по запросу воркера, у которого нет
 * заголовка Origin, а модульный скрипт браузер грузит в режиме CORS и Origin
 * добавляет — по Vary это уже другой запрос, и cache.match промахивается.
 * Проверено офлайном: без ignoreVary документ поднимался из кеша, а бандл получал
 * 504, то есть игра стартовала пустым экраном. Для предкеша статики Vary — шум.
 */
const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache: 'reload' — тянем из сети, а не из HTTP-кеша браузера: иначе в
      // предкеш может лечь устаревшая копия ассета.
      await cache.addAll(PRECACHE.map((path) => new Request(url(path), { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Кеши прошлых версий удаляем: имя содержит хеш содержимого сборки.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/*
 * Документ из сети, мимо всех кешей.
 *
 * cache: 'reload' — обход HTTP-кеша браузера. Он обязателен: GitHub Pages отдаёт
 * index.html с «Cache-Control: max-age=600» и заголовки на нём не настраиваются,
 * так что без этого флага свежий документ до десяти минут не виден даже при
 * живой сети.
 */
async function fetchDocument() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    return await fetch(url('./'), { cache: 'reload', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      /*
       * Навигация: СНАЧАЛА сеть, кеш — только запасной вариант.
       *
       * index.html — единственный файл сборки с постоянным именем, и именно он
       * называет имя бандла (assets/index-<хеш>.js). Отдавай мы его из кеша,
       * устройство сидело бы на старой версии до тех пор, пока не установится
       * новый воркер, то есть всегда на одну перезагрузку позади. Свежий документ
       * тянет за собой свежий скрипт, поэтому обновление приходит целиком.
       *
       * Офлайн-запуск это не ломает: сеть отвалилась — ниже отдаётся копия из
       * предкеша, ровно как раньше.
       */
      if (request.mode === 'navigate') {
        try {
          const fresh = await fetchDocument();
          if (fresh.ok) {
            // Кладём под адрес навигации: с ним игра поднимется офлайн, и это
            // единственный способ обновить документ в кеше, когда сборка сменила
            // только разметку и версия воркера осталась прежней.
            await cache.put(url('./'), fresh.clone());
            return fresh;
          }
        } catch {
          // Сети нет или ответ не дождались — падаем в кеш.
        }
        const cached = await cache.match(url('./'), MATCH);
        if (cached) return cached;
      }

      const hit = await cache.match(request, MATCH);
      if (hit) return hit;

      try {
        const response = await fetch(request);
        /*
         * Промах по своему origin — это, как правило, ассет НОВОЙ сборки: свежий
         * index.html уже пришёл из сети и просит бандл, которого в кеше текущей
         * версии нет. Складываем его сразу, не дожидаясь установки нового
         * воркера: иначе между приходом нового документа и его установкой игра
         * осталась бы без офлайн-запуска.
         */
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        // Офлайн и в кеше нет — отвечать нечем; 504 честнее падения.
        return new Response('Офлайн: ресурс не в кеше', {
          status: 504,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })(),
  );
});
`;
}

export default defineConfig({
  // './' — сборку можно открыть с файловой системы или из любой подпапки
  base: './',
  plugins: [precacheServiceWorker()],
  server: {
    // host: true — можно открыть с телефона по IP машины в той же сети
    host: true,
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
