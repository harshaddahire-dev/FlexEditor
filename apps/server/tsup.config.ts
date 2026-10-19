import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Workspace packages ship as TypeScript source, so they must be bundled in.
  noExternal: [/^@cutroom\//],
  external: ['better-sqlite3'],
});
