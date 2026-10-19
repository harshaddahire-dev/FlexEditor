import { defineConfig } from 'vitest/config';

// Serial files: the latency tests measure wall-clock time and must not compete with the property suites for CPU.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], fileParallelism: false } });
