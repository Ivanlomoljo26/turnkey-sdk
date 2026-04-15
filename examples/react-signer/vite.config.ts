import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';
import { fileURLToPath } from 'url';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util'],
    }),
  ],
  optimizeDeps: {
    exclude: ['@miden-sdk/miden-sdk', '@miden-sdk/miden-sdk-original'],
  },
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      '@miden-sdk/miden-turnkey': path.resolve(__dirname, '..', '..', 'src', 'index.ts'),
      '@miden-sdk/miden-turnkey-react': path.resolve(__dirname, '..', '..', 'packages', 'use-miden-turnkey-react', 'src', 'index.ts'),
      // Workaround for @miden-sdk/react@0.14.x reading AuthScheme.AuthEcdsaK256Keccak
      // from @miden-sdk/miden-sdk — the package's main export shadows the WASM enum
      // with a string-constant object, so react's read evaluates to undefined.
      // See src/miden-sdk-shim.ts for the patched re-export.
      '@miden-sdk/miden-sdk-original': path.resolve(__dirname, '..', '..', 'node_modules', '@miden-sdk', 'miden-sdk'),
      '@miden-sdk/miden-sdk': path.resolve(__dirname, 'src', 'miden-sdk-shim.ts'),
    },
    dedupe: ['@miden-sdk/miden-sdk', '@miden-sdk/react', 'react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..', '..')],
    },
  },
  worker: {
    format: 'es',
  },
});
