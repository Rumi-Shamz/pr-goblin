// capture.js — remembers the last few errors the page produced, so a bug
// report can carry them without the reporter doing anything.
//
// Captured: console.error, console.warn, uncaught exceptions, unhandled
// promise rejections, and fetch calls that failed or returned 4xx/5xx.
// Kept in memory only, in a small ring buffer, and sent only when the user
// submits a bug report.
//
// Privacy: query strings and fragments are stripped from captured URLs
// (they are where tokens tend to live), request and response bodies are
// never read, and every message is truncated.

export const MAX_ENTRIES = 30
export const MAX_MESSAGE = 500

function stringify(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ? String(value.stack) : `${value.name}: ${value.message}`
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** "https://x.test/a/b?token=1#h" → "https://x.test/a/b" */
export function stripUrl(url) {
  const s = String(url)
  const cut = s.search(/[?#]/)
  return cut === -1 ? s : s.slice(0, cut)
}

export class LogCapture {
  /** @param {{ ignoreUrl?: string }} [opts] ignoreUrl: requests to this URL (the widget's own endpoint) are not recorded. */
  constructor(opts = {}) {
    this._entries = []
    this._ignoreUrl = opts.ignoreUrl ? stripUrl(opts.ignoreUrl) : null
    this._installed = false
  }

  _push(level, message) {
    const text = String(message).slice(0, MAX_MESSAGE)
    // The widget's own diagnostics are noise in a report about the host app.
    if (text.startsWith('[pr-goblin]')) return
    this._entries.push({ level, message: text, ts: new Date().toISOString() })
    if (this._entries.length > MAX_ENTRIES) this._entries.shift()
  }

  /** A copy of what has been captured so far, oldest first. */
  entries() {
    return this._entries.map((e) => ({ ...e }))
  }

  clear() {
    this._entries = []
  }

  install() {
    if (this._installed || typeof window === 'undefined') return
    this._installed = true

    this._origError = console.error
    this._origWarn = console.warn
    const self = this
    console.error = function (...args) {
      try { self._push('error', args.map(stringify).join(' ')) } catch { /* never break the host's logging */ }
      return self._origError.apply(this, args)
    }
    console.warn = function (...args) {
      try { self._push('warn', args.map(stringify).join(' ')) } catch { /* as above */ }
      return self._origWarn.apply(this, args)
    }
    this._wrappedError = console.error
    this._wrappedWarn = console.warn

    this._onError = (event) => {
      const where = event.filename ? ` (${stripUrl(event.filename)}:${event.lineno ?? 0})` : ''
      this._push('exception', `${event.message || 'Script error'}${where}`)
    }
    this._onRejection = (event) => {
      this._push('rejection', stringify(event.reason))
    }
    window.addEventListener('error', this._onError)
    window.addEventListener('unhandledrejection', this._onRejection)

    if (typeof window.fetch === 'function') {
      this._origFetch = window.fetch
      const origFetch = this._origFetch
      const wrapped = function (input, init) {
        let url = ''
        let method = 'GET'
        try {
          url = stripUrl(typeof input === 'string' ? input : input?.url ?? String(input))
          method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
        } catch { /* leave defaults */ }
        const record = url !== self._ignoreUrl
        return origFetch.apply(this, arguments).then(
          (response) => {
            if (record && response && response.status >= 400) self._push('network', `${method} ${url} ${response.status}`)
            return response
          },
          (err) => {
            if (record) self._push('network', `${method} ${url} failed: ${err?.message ?? err}`)
            throw err
          },
        )
      }
      window.fetch = wrapped
      this._wrappedFetch = wrapped
    }
  }

  /** Put back whatever we replaced, unless someone else has wrapped it since. */
  uninstall() {
    if (!this._installed) return
    this._installed = false
    if (console.error === this._wrappedError) console.error = this._origError
    if (console.warn === this._wrappedWarn) console.warn = this._origWarn
    window.removeEventListener('error', this._onError)
    window.removeEventListener('unhandledrejection', this._onRejection)
    if (this._wrappedFetch && window.fetch === this._wrappedFetch) window.fetch = this._origFetch
  }
}
