import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // hook-relay.js and mcp-relay.js are run by Claude Code (hooks, MCP server) as standalone scripts (see infrastructure/hooks and mcp)
    build: { minify: true, sourcemap: false, rollupOptions: { input: { index: resolve('src/main/index.ts'), 'hook-relay': resolve('src/main/infrastructure/hooks/relay.ts'), 'mcp-relay': resolve('src/main/infrastructure/mcp/relay.ts') } } },
  },
  preload: {
    // sandboxed preload: single CJS bundle, only `electron` is external
    build: {
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    // never inline assets as data: URIs (fonts must come from 'self')
    build: { minify: true, sourcemap: false, assetsInlineLimit: 0, rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    plugins: [react(), tailwindcss()],
  },
})
