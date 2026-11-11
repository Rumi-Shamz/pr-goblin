import { PrGoblinWidget } from './widget.js'

// Single source of truth for the widget version. Bump this in lockstep
// with the git release tag (the repo releases via ./release.sh vX.Y.Z).
// It is exposed on the PrGoblin object and stamped as a build banner so
// vendored IIFE copies in host sites are identifiable.
const VERSION = '1.3.1'

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
