import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'

// The version comes from package.json, which the release workflow sets from
// the git tag (v0.2.0 -> 0.2.0). It is also injected as __PR_GOBLIN_VERSION__.
const WIDGET_VERSION = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
const BANNER = `/* pr-goblin-widget v${WIDGET_VERSION} */`

// Prepend the version banner to every built bundle (es, umd, iife) so
// vendored copies in host sites are identifiable. Done as a post-write
// step because, in Vite lib multi-format mode, a shared output.banner /
// renderChunk prefix only lands on the ES pass; the umd/iife wrapper +
// minify drop it. window.PrGoblin.version carries the same string at
// runtime.
const versionBanner = {
  name: 'pr-goblin-version-banner',
  writeBundle(options, bundle) {
    const outDir = options.dir
    for (const file of Object.keys(bundle)) {
      const chunk = bundle[file]
      if (chunk.type !== 'chunk' || !chunk.isEntry) continue
      const path = resolve(outDir, file)
      const code = readFileSync(path, 'utf8')
      if (code.startsWith(BANNER)) continue
      writeFileSync(path, `${BANNER}\n${code}`)
    }
  },
}

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'PrGoblin',
      formats: ['es', 'umd', 'iife'],
      // Single default export — IIFE exposes window.PrGoblin directly

      fileName: (format) => `pr-goblin.${format}.js`,
    },
    rolldownOptions: {
      // html2canvas is bundled — consumers shouldn't need to install it separately
    },
  },
  define: { __PR_GOBLIN_VERSION__: JSON.stringify(WIDGET_VERSION) },
  plugins: [versionBanner],
  // Dev server points at the test harness
  root: '.',
  server: {
    open: '/test/index.html',
  },
})
