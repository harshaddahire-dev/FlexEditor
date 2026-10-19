import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // ffmpeg-heavy suites: keep files serial so they don't fight for CPU.
    fileParallelism: false,
  },
});
