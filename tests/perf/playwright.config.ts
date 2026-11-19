import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: '.', workers: 1, timeout: 300_000, reporter: 'line' })
