import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', globalSetup: './setup.ts', workers: 1, timeout: 300_000, reporter: 'line' })
