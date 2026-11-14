import { defineConfig } from '@playwright/test'

// two workers: each test launches Electron plus real PTYs, and four at once made unrelated tests time out now and then
export default defineConfig({ testDir: 'tests/e2e', timeout: 30_000, workers: 2 })
