import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import PrGoblin from '../src/index.js'
import { THEMED_DEFAULTS, buildTheme, detectTheme, mix, readHost, saturation, toRgb } from '../src/theme.js'
import { contrastRatio, parseRgbString } from '../src/colour.js'

const rgb = (r, g, b) => ({ r, g, b })
const AMBER = rgb(180, 83, 9)
const WHITE = rgb(255, 255, 255)
const INK = rgb(23, 23, 23)

afterEach(() => {
  PrGoblin.destroy()
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('class')
})

describe('THEMED_DEFAULTS', () => {
  it('matches the stylesheet, so host overrides are detected correctly', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    for (const [name, value] of Object.entries(THEMED_DEFAULTS)) {
      expect(css).toContain(`${name}: ${value};`)
    }
  })
})

describe('colour helpers', () => {
  it('saturation separates brand colours from greys', () => {
    expect(saturation(rgb(128, 128, 128))).toBe(0)
    expect(saturation(AMBER)).toBeGreaterThan(0.9)
  })

  it('mix interpolates', () => {
    expect(mix(rgb(0, 0, 0), WHITE, 0.5)).toEqual(rgb(128, 128, 128))
  })

  it('toRgb reads rgb(), and rejects transparent and unreadable values', () => {
    expect(toRgb('rgb(1, 2, 3)')).toEqual(rgb(1, 2, 3))
    expect(toRgb('rgba(1, 2, 3, 0.9)')).toEqual(rgb(1, 2, 3))
    expect(toRgb('rgba(0, 0, 0, 0)')).toBeNull()
    expect(toRgb('transparent')).toBeNull()
    expect(toRgb('')).toBeNull()
  })
})

describe('buildTheme', () => {
  it('returns nothing when it knows nothing', () => {
    expect(buildTheme({})).toEqual({})
    expect(buildTheme()).toEqual({})
  })

  it('themes a light page with a brand colour', () => {
    const v = buildTheme({ primary: AMBER, surface: WHITE, text: INK, font: 'Inter, sans-serif', radius: 6 })
    expect(v['--bp-primary']).toBe('rgb(180, 83, 9)')
    expect(v['--bp-on-primary']).toBe('rgb(255, 255, 255)')
    expect(v['--bp-surface']).toBe('rgb(255, 255, 255)')
    expect(v['--bp-text']).toBe('rgb(23, 23, 23)')
    expect(v['--bp-font']).toBe('Inter, sans-serif')
    expect(v['--bp-radius-sm']).toBe('6px')
    expect(v['--bp-radius']).toBe('9px')
    expect(v['--bp-radius-xs']).toBe('4px')
  })

  it('themes a dark page and picks dark text on a light brand colour', () => {
    const dark = rgb(12, 10, 9)
    const light = rgb(250, 250, 249)
    const v = buildTheme({ primary: rgb(251, 191, 36), surface: dark, text: light })
    expect(v['--bp-surface']).toBe('rgb(12, 10, 9)')
    expect(v['--bp-on-primary']).toBe('rgb(23, 23, 23)')
    const border = parseRgbString(v['--bp-border'])
    expect(contrastRatio(border, dark)).toBeGreaterThan(1.1)
  })

  it('keeps muted text readable on light and dark surfaces', () => {
    for (const [surface, text] of [[WHITE, INK], [rgb(12, 10, 9), rgb(250, 250, 249)], [rgb(245, 240, 230), rgb(60, 50, 40)]]) {
      const v = buildTheme({ surface, text })
      expect(contrastRatio(parseRgbString(v['--bp-text-muted']), surface)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('ignores a surface and text pair that cannot be read together', () => {
    const v = buildTheme({ surface: WHITE, text: rgb(240, 240, 240), primary: AMBER })
    expect(v['--bp-surface']).toBeUndefined()
    expect(v['--bp-text']).toBeUndefined()
    expect(v['--bp-primary']).toBe('rgb(180, 83, 9)')
  })

  it('falls back to the text colour when the brand colour would vanish on the surface', () => {
    const v = buildTheme({ primary: rgb(250, 250, 250), surface: WHITE, text: INK })
    expect(v['--bp-primary']).toBe('rgb(23, 23, 23)')
    expect(v['--bp-on-primary']).toBe('rgb(255, 255, 255)')
  })

  it('always gives readable text on the primary button', () => {
    for (const primary of [AMBER, rgb(251, 191, 36), rgb(37, 99, 235), rgb(16, 185, 129), rgb(0, 0, 0), rgb(255, 255, 0)]) {
      const v = buildTheme({ primary, surface: WHITE, text: INK })
      const ratio = contrastRatio(parseRgbString(v['--bp-on-primary']), parseRgbString(v['--bp-primary']))
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('caps pill-shaped host radii so fields stay rectangular', () => {
    const v = buildTheme({ radius: 9999 })
    expect(v['--bp-radius-sm']).toBe('12px')
    expect(v['--bp-radius']).toBe('16px')
    expect(buildTheme({ radius: 0 })['--bp-radius']).toBe('0px')
    expect(buildTheme({ radius: NaN })['--bp-radius']).toBeUndefined()
  })
})

describe('readHost', () => {
  it('reads background, text colour and font from the body', () => {
    document.body.style.backgroundColor = 'rgb(12, 10, 9)'
    document.body.style.color = 'rgb(250, 250, 249)'
    document.body.style.fontFamily = 'Inter, sans-serif'
    const host = readHost(document)
    expect(host.surface).toEqual(rgb(12, 10, 9))
    expect(host.text).toEqual(rgb(250, 250, 249))
    expect(host.font).toBe('Inter, sans-serif')
  })

  it('takes the brand colour and radius from the most colourful button', () => {
    document.body.innerHTML = `
      <button style="background-color: rgb(229, 229, 229); border-radius: 2px">Cancel</button>
      <button style="background-color: rgb(37, 99, 235); border-top-left-radius: 8px">Save</button>`
    const host = readHost(document)
    expect(host.primary).toEqual(rgb(37, 99, 235))
    expect(host.radius).toBe(8)
  })

  it('does not treat a grey button as a brand colour', () => {
    document.body.innerHTML = '<button style="background-color: rgb(229, 229, 229)">Cancel</button>'
    expect(readHost(document).primary).toBeNull()
  })

  it('leaves no probe element behind', () => {
    document.body.innerHTML = '<p>hi</p>'
    readHost(document)
    expect(document.body.children.length).toBe(1)
  })
})

describe('detectTheme', () => {
  it('lets an explicit colour replace the detected one', () => {
    document.body.innerHTML = '<button style="background-color: rgb(37, 99, 235)">Save</button>'
    expect(detectTheme(document, { color: '#b45309' })['--bp-primary']).toBe('rgb(180, 83, 9)')
  })

  it('leaves alone a variable the host set in its own CSS', () => {
    document.documentElement.style.setProperty('--bp-font', 'Georgia, serif')
    document.body.style.fontFamily = 'Inter, sans-serif'
    expect(detectTheme(document)['--bp-font']).toBeUndefined()
  })
})

describe('widget integration', () => {
  const init = (extra = {}) => PrGoblin.init({ endpoint: 'https://example.test/feedback', projectName: 'Test', ...extra })

  it('applies the host look to the trigger and dialog by default', () => {
    document.body.style.backgroundColor = 'rgb(12, 10, 9)'
    document.body.style.color = 'rgb(250, 250, 249)'
    document.body.style.fontFamily = 'Inter, sans-serif'
    init()
    for (const sel of ['.bp-trigger', '.bp-dialog']) {
      const el = document.querySelector(sel)
      expect(el.style.getPropertyValue('--bp-surface')).toBe('rgb(12, 10, 9)')
      expect(el.style.getPropertyValue('--bp-font')).toBe('Inter, sans-serif')
    }
  })

  it('does nothing with theme: "none"', () => {
    document.body.style.backgroundColor = 'rgb(12, 10, 9)'
    document.body.style.color = 'rgb(250, 250, 249)'
    init({ theme: 'none' })
    expect(document.querySelector('.bp-dialog').style.getPropertyValue('--bp-surface')).toBe('')
  })

  it('re-reads the page when the dialog opens', () => {
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
    document.body.style.color = 'rgb(23, 23, 23)'
    const w = init()
    document.body.style.backgroundColor = 'rgb(12, 10, 9)'
    document.body.style.color = 'rgb(250, 250, 249)'
    w.open()
    expect(document.querySelector('.bp-dialog').style.getPropertyValue('--bp-surface')).toBe('rgb(12, 10, 9)')
  })

  it('drops a themed variable once the page stops giving a basis for it', () => {
    document.body.style.backgroundColor = 'rgb(12, 10, 9)'
    document.body.style.color = 'rgb(250, 250, 249)'
    const w = init()
    document.body.removeAttribute('style')
    w.open()
    expect(document.querySelector('.bp-dialog').style.getPropertyValue('--bp-surface')).toBe('')
  })
})
