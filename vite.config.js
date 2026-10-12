import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: el build se puede servir desde cualquier subcarpeta (GitHub Pages, Netlify).
  base: './',
  build: {
    rollupOptions: {
      input: {
        login: resolve(import.meta.dirname, 'index.html'),
        panel: resolve(import.meta.dirname, 'panel.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
