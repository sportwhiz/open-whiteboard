import { buildInfo } from '../../scripts/releases/build-info.mjs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';
import { adaptEmbedSource, isEmbedAdaptation } from './src/blocksuite/embed-branding';

const packageStore = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/.pnpm'
);
const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'src');
const blockSuitePackages = [
  ...new Set(
    readdirSync(packageStore)
      .map(entry => entry.match(/^@blocksuite\+(.+?)@/u)?.[1])
      .filter((name): name is string => Boolean(name))
      .map(name => `@blocksuite/${name}`)
  ),
];

function compileBlockSuiteSources(): Plugin {
  return {
    name: 'compile-blocksuite-sources',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.includes('/@blocksuite/affine-block-code/src/') && /(?:^|\/)code-block-service\.js$/u.test(source)) {
        return resolve(sourceDirectory, 'blocksuite/lazy-highlighter.ts');
      }
      if (source === 'shiki') return resolve(sourceDirectory, 'blocksuite/lazy-shiki.ts');
      return null;
    },
    load(id) {
      const sourceId = id.split('?')[0];
      if (sourceId.includes('/node_modules/') &&
          sourceId.includes('@blocksuite+') && isEmbedAdaptation(sourceId)) {
        // Adapt before Rollup records the source, so source maps describe the
        // modules actually distributed with this application.
        return adaptEmbedSource(readFileSync(sourceId, 'utf8'), sourceId);
      }
      return null;
    },
    async transform(code, id) {
      const sourceId = id.split('?')[0];
      if (
        !sourceId.includes('/node_modules/') ||
        !sourceId.includes('@blocksuite+') ||
        !sourceId.endsWith('.ts')
      ) {
        return null;
      }

      const result = await transformWithEsbuild(code, sourceId, {
        loader: 'ts',
        target: 'es2022',
        tsconfigRaw: {
          compilerOptions: { useDefineForClassFields: false },
        },
      });
      return { code: result.code, map: result.map as never };
    },
  };
}

export default defineConfig({
  define: { __HUDDLE_RELEASE__: JSON.stringify(buildInfo(resolve(sourceDirectory, '../../..'))) },
  resolve: {
    alias: {
      '@blocksuite/std/gfx': resolve(
        packageStore,
        '@blocksuite+std@0.22.4/node_modules/@blocksuite/std/src/gfx/index.ts'
      ),
    },
  },
  plugins: [
    compileBlockSuiteSources(),
    vanillaExtractPlugin(),
    react(),
    ...(process.env.HUDDLE_BUILD_TARGET === 'node' ? [] : [cloudflare({ configPath: process.env.WHITEBOARD_WRANGLER_CONFIG ?? ((process.env.WORKERS_CI || process.env.WRANGLER_CI_OVERRIDE_NAME) ? "../../wrangler.jsonc" : undefined), ...(process.env.WHITEBOARD_WRANGLER_CONFIG?.startsWith('tests/') ? { persistState: { path: `${dirname(process.env.WHITEBOARD_WRANGLER_CONFIG)}/.wrangler/state` } } : {}) })]),
  ],
  optimizeDeps: {
    // BlockSuite is served from source; its CommonJS clipboard compressor
    // needs explicit namespace interop in development as well as the build.
    needsInterop: ['@blocksuite/std > lz-string'],
    exclude: [
      ...blockSuitePackages,
      '@lit/reactive-element',
      'lit',
      'lit-element',
      'lit-html',
      'yjs',
      'y-protocols',
    ],
    esbuildOptions: {
      target: 'es2022',
      tsconfigRaw: {
        compilerOptions: { useDefineForClassFields: false },
      },
    },
    include: [
      '@blocksuite/std > lz-string',
      'bind-event-listener',
      'bytes',
      'change-case',
      'debug',
      'deepmerge',
      'extend',
      // Imported by board layer ordering. Pre-bundle it so a fresh dev server
      // never re-optimizes and reloads the page while a board is open.
      'fractional-indexing',
      // The code highlighter loads lazily on first board open; listing it here
      // avoids the same mid-session re-optimization and reload.
      'shiki/core',
      'shiki/engine/oniguruma',
      'shiki/wasm',
      'shiki/themes/dark-plus.mjs',
      'shiki/themes/light-plus.mjs',
      'shiki/langs',
      'shiki/bundle/full',
      'lodash.clonedeep',
      'lodash.ismatch',
      'lodash.merge',
      'picocolors',
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
    ],
  },
  build: {
    target: 'es2022',
    sourcemap: process.env.HUDDLE_BUILD_TARGET !== 'node',
    ...(process.env.HUDDLE_BUILD_TARGET === 'node' ? { outDir: 'dist-node/client' } : {}),
  },
});
