import { defineConfig } from 'vitest/config'

// Runs under Electron's Node (see `npm run test:db`): better-sqlite3 is a native module.
export default defineConfig({ test: { include: ['tests/db/**/*.test.ts'] } })
