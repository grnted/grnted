// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The gold standard runs on its own (`pnpm test:gold`, vitest.gold.config.ts): it scans the gold
    // site about 150 times.
    exclude: [...configDefaults.exclude, 'test/gold/**'],
    testTimeout: 10_000,
    hookTimeout: 30_000,
  },
});
