import { readFileSync } from 'fs'
import { defineConfig } from 'vitest/config'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: { __PR_GOBLIN_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
  },
})
