import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'

// Keep in lockstep with VERSION in src/index.js and the git release tag.
const WIDGET_VERSION = '1.3.1'
const BANNER = `/* bugpilot-widget v${WIDGET_VERSION} */`

// Prepend the version banner to every built bundle (es, umd, iife) so
// vendored copies in host sites are identifiable. Done as a post-write
// step because, in Vite lib multi-format mode, a shared output.banner /
// renderChunk prefix only lands on the ES pass; the umd/iife wrapper +
// minify drop it. window.BugPilot.version carries the same string at
// runtime.
const versionBanner = {
  name: 'bugpilot-version-banner',
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
      name: 'BugPilot',
      formats: ['es', 'umd', 'iife'],
      // Single default export — IIFE exposes window.BugPilot directly

      fileName: (format) => `bugpilot.${format}.js`,
    },
    rolldownOptions: {
      // html2canvas is bundled — consumers shouldn't need to install it separately
    },
  },
  plugins: [versionBanner],
  // Dev server points at the test harness
  root: '.',
  server: {
    open: '/test/index.html',
  },
})
