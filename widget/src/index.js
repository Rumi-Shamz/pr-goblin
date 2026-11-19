import { PrGoblinWidget } from './widget.js'

// The widget version, injected at build time from package.json (which the
// release workflow sets from the git tag). It is exposed on the PrGoblin
// object and stamped as a build banner so vendored copies are identifiable.
const VERSION = typeof __PR_GOBLIN_VERSION__ === 'string' ? __PR_GOBLIN_VERSION__ : 'dev'

let _instance = null

const PrGoblin = {
  version: VERSION,

  init(config) {
    if (_instance) {
      console.warn('[pr-goblin] already initialised — call PrGoblin.destroy() first to re-init')
      return _instance
    }
    if (!config?.endpoint) {
      throw new Error('[pr-goblin] config.endpoint is required')
    }
    _instance = new PrGoblinWidget(config)
    return _instance
  },

  open() {
    _instance?.open()
  },

  close() {
    _instance?.close()
  },

  destroy() {
    _instance?.destroy()
    _instance = null
  },
}

export default PrGoblin
