/**
 * Версия игры, подставляется на сборке из поля `version` в package.json
 * (define в vite.config.ts). Строка вида «1.0.0».
 *
 * Именно define, а не импорт package.json: иначе в бандл попал бы весь манифест
 * со списком зависимостей, а версия нужна одна.
 */
declare const __APP_VERSION__: string;
