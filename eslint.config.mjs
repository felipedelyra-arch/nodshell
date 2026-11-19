import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'test-results/**', '.claude/**', 'tests/perf/out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
