import { build } from 'vite';
import { resolve } from 'node:path';
import { mkdir, cp, writeFile } from 'node:fs/promises';

await build();
await build({
  configFile: false,
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist/lib',
    sourcemap: true,
    lib: { entry: resolve('src/index.js'), formats: ['es'], fileName: () => 'player.js' },
  },
});

// Keep the preferred form of our code, exact binary manifests, upstream build
// instructions and patch available alongside every distributed demo.
await mkdir('dist/source', { recursive: true });
for (const entry of ['src', 'scripts', 'docs', 'demo', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js', 'LICENSE', 'README.md']) {
  await cp(entry, `dist/source/${entry}`, { recursive: true });
}
await writeFile('dist/SOURCE.txt', 'Octo Player corresponding source and build instructions: ./source/README.md\nThird-party source revisions and build scripts: ./source/docs/THIRD_PARTY.md\nThis distribution is GPL-3.0-or-later; see ./source/LICENSE.\n');
