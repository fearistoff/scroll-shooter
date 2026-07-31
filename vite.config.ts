import { defineConfig } from 'vite';

export default defineConfig({
  // './' — сборку можно открыть с файловой системы или из любой подпапки
  base: './',
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
