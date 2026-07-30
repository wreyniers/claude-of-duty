import { defineConfig } from 'vite';

/**
 * Vite config for the automated harnesses.
 *
 * Identical to the root config except that hot reload and file watching are off.
 * With them on, any edit to a source file while a harness is running reloads the
 * page under it and destroys the execution context mid-run — which in a repo
 * where several agents edit concurrently reads as a mysterious harness crash and
 * throws away however many minutes of rendering had accumulated. A harness run
 * should see the code as it was when the run started, and nothing else.
 */
export default defineConfig({
  server: {
    host: '127.0.0.1',
    strictPort: true,
    hmr: false,
    watch: { ignored: ['**/*'] },
  },
  build: { target: 'es2022', sourcemap: true },
});
