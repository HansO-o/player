import { defineConfig } from 'vite';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: './',
  server: { headers, port: 5173, strictPort: true, hmr: process.env.OCTO_TEST ? false : undefined },
  preview: { headers, port: 4173, strictPort: true },
  build: { target: 'es2022', sourcemap: true, outDir: 'dist' },
});
