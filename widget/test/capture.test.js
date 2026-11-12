import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogCapture, MAX_ENTRIES, MAX_MESSAGE, stripUrl } from '../src/capture.js'
import PrGoblin from '../src/index.js'

describe('stripUrl', () => {
  it('drops query strings and fragments, where tokens tend to live', () => {
    expect(stripUrl('https://x.test/a/b?token=secret&x=1#frag')).toBe('https://x.test/a/b')
    expect(stripUrl('https://x.test/a#frag')).toBe('https://x.test/a')
    expect(stripUrl('/relative/path')).toBe('/relative/path')
  })
})

describe('LogCapture', () => {
  let capture
  let origError
  let origWarn
  let origFetch

  beforeEach(() => {
    origError = console.error
    origWarn = console.warn
    origFetch = window.fetch
    // Silence the real console while still letting the wrapper call through.
    console.error = vi.fn()
    console.warn = vi.fn()
    capture = new LogCapture({ ignoreUrl: 'https://intake.test/feedback' })
  })

  afterEach(() => {
    capture.uninstall()
    console.error = origError
    console.warn = origWarn
    window.fetch = origFetch
  })

  it('records console.error and console.warn and still calls the originals', () => {
    const errorSpy = console.error
    capture.install()

    console.error('save failed', { code: 7 })
    console.warn('deprecated')

    expect(capture.entries().map((e) => [e.level, e.message])).toEqual([
      ['error', 'save failed {"code":7}'],
      ['warn', 'deprecated'],
    ])
    expect(errorSpy).toHaveBeenCalledWith('save failed', { code: 7 })
  })

  it('records Error objects with their stack', () => {
    capture.install()
    console.error(new TypeError('x is undefined'))

    expect(capture.entries()[0].message).toContain('TypeError: x is undefined')
  })

  it('does not record the widget\'s own diagnostics', () => {
    capture.install()
    console.error('[pr-goblin] submit failed')

    expect(capture.entries()).toEqual([])
  })

  it('records uncaught exceptions and unhandled rejections', () => {
    capture.install()

    window.dispatchEvent(new window.ErrorEvent('error', { message: 'boom', filename: 'https://x.test/app.js?v=3', lineno: 12 }))
    const rejection = new window.Event('unhandledrejection')
    rejection.reason = new Error('nope')
    window.dispatchEvent(rejection)

    const [exception, rejected] = capture.entries()
    expect(exception).toMatchObject({ level: 'exception', message: 'boom (https://x.test/app.js:12)' })
    expect(rejected.level).toBe('rejection')
    expect(rejected.message).toContain('nope')
  })

  it('records failed and 4xx/5xx fetches without the query string, and ignores successes', async () => {
    window.fetch = vi.fn(async (url) => {
      if (String(url).includes('/ok')) return { status: 200 }
      if (String(url).includes('/down')) throw new TypeError('Failed to fetch')
      return { status: 500 }
    })
    capture.install()

    await window.fetch('https://api.test/ok?x=1')
    await window.fetch('https://api.test/save?token=secret', { method: 'post' })
    await expect(window.fetch('https://api.test/down')).rejects.toThrow('Failed to fetch')

    expect(capture.entries().map((e) => e.message)).toEqual([
      'POST https://api.test/save 500',
      'GET https://api.test/down failed: Failed to fetch',
    ])
    expect(JSON.stringify(capture.entries())).not.toContain('secret')
  })

  it('does not record requests to the widget\'s own endpoint', async () => {
    window.fetch = vi.fn(async () => ({ status: 502 }))
    capture.install()

    await window.fetch('https://intake.test/feedback', { method: 'POST' })

    expect(capture.entries()).toEqual([])
  })

  it('keeps only the most recent entries and truncates long messages', () => {
    capture.install()
    for (let i = 0; i < MAX_ENTRIES + 10; i++) console.warn(`w${i}`)
    console.warn('x'.repeat(MAX_MESSAGE * 3))

    const entries = capture.entries()
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0].message).toBe('w11')
    expect(entries.at(-1).message).toHaveLength(MAX_MESSAGE)
  })

  it('restores console and fetch on uninstall', () => {
    const before = { error: console.error, warn: console.warn, fetch: window.fetch }
    capture.install()
    expect(console.error).not.toBe(before.error)

    capture.uninstall()

    expect(console.error).toBe(before.error)
    expect(console.warn).toBe(before.warn)
    expect(window.fetch).toBe(before.fetch)
  })

  it('leaves a later wrapper in place instead of clobbering it on uninstall', () => {
    capture.install()
    const later = vi.fn()
    console.error = later

    capture.uninstall()

    expect(console.error).toBe(later)
  })
})

describe('widget + capture', () => {
  let origFetch
  let origError

  beforeEach(() => {
    origFetch = window.fetch
    origError = console.error
    console.error = vi.fn()
  })

  afterEach(() => {
    PrGoblin.destroy()
    window.fetch = origFetch
    console.error = origError
  })

  function fillAndSubmit(instance) {
    document.getElementById('bp-what-happened').value = 'Save does nothing'
    document.getElementById('bp-expected').value = 'It saves'
    return instance._submit()
  }

  it('sends captured errors with a bug report', async () => {
    const sent = []
    window.fetch = vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body))
      return { ok: true, status: 201, json: async () => ({ ok: true, issueUrl: 'https://x.test/1' }) }
    })
    const instance = PrGoblin.init({ endpoint: 'https://intake.test/feedback', projectName: 'T' })
    console.error('TypeError: cannot read save')

    PrGoblin.open()
    await fillAndSubmit(instance)
    expect(sent).toHaveLength(1)

    expect(sent[0].context.logs.map((l) => l.message)).toEqual(['TypeError: cannot read save'])
  })

  it('captures nothing when captureLogs is false', async () => {
    const sent = []
    window.fetch = vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body))
      return { ok: true, status: 201, json: async () => ({ ok: true }) }
    })
    const instance = PrGoblin.init({ endpoint: 'https://intake.test/feedback', projectName: 'T', captureLogs: false })
    console.error('ignored')

    PrGoblin.open()
    await fillAndSubmit(instance)
    expect(sent).toHaveLength(1)

    expect(sent[0].context.logs).toBeUndefined()
  })
})
