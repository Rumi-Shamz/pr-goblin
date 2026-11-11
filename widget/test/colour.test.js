import { describe, expect, it } from 'vitest'
import { parseRgbString, relativeLuminance, contrastRatio, computeHoverRgb } from '../src/colour.js'

describe('parseRgbString', () => {
  it('parses rgb() and rgba(), the only shapes getComputedStyle returns', () => {
    expect(parseRgbString('rgb(28, 27, 26)')).toEqual({ r: 28, g: 27, b: 26 })
    expect(parseRgbString('rgba(255, 246, 229, 1)')).toEqual({ r: 255, g: 246, b: 229 })
  })

  it('returns null for anything getComputedStyle would not actually produce', () => {
    expect(parseRgbString('var(--bp-on-primary)'), 'an unresolved custom property, e.g. jsdom').toBeNull()
    expect(parseRgbString('#ffffff'), 'a hex literal is never what a real computed style returns').toBeNull()
    expect(parseRgbString('')).toBeNull()
    expect(parseRgbString(undefined)).toBeNull()
    expect(parseRgbString('transparent')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('white is 1, black is 0', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
  })

  it('matches an independently computed value for a known grey (#767676, the WCAG spec\'s own 4.5:1-against-white example)', () => {
    // Verified separately in Python with the same formula rather than
    // recalled from memory, since a mis-remembered "known" constant here
    // would make every test built on it pass for the wrong reason.
    expect(relativeLuminance({ r: 0x76, g: 0x76, b: 0x76 })).toBeCloseTo(0.18116, 5)
  })
})

describe('contrastRatio', () => {
  it('black on white is 21:1, identical colours are 1:1', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0)
    expect(contrastRatio({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 })).toBeCloseTo(1, 5)
  })

  it('is symmetric: argument order does not matter', () => {
    const a = { r: 28, g: 27, b: 26 }
    const b = { r: 201, g: 197, b: 188 }
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })
})

describe('computeHoverRgb', () => {
  const LIGHT = { r: 224, g: 224, b: 224 } // #e0e0e0
  const DARK = { r: 38, g: 38, b: 38 } // #262626, the widget's own default --bp-primary
  const WHITE = { r: 255, g: 255, b: 255 }
  const GRAPHITE = { r: 28, g: 27, b: 26 } // #1c1b1a

  it('control: the OLD unconditional-towards-white formula for a light colour, so a regression back to it is visible by name', () => {
    const oldFormula = (c) => Math.round(c + (255 - c) * 0.15)
    const oldHover = { r: oldFormula(LIGHT.r), g: oldFormula(LIGHT.g), b: oldFormula(LIGHT.b) }
    expect(oldHover).toEqual({ r: 229, g: 229, b: 229 })
    expect(contrastRatio(WHITE, oldHover), 'control: the old value really was close to invisible against a white icon').toBeLessThan(1.5)
  })

  it('a LIGHT colour with a white on-primary blends towards BLACK, far enough to actually clear 3:1: a fixed 15% step the other way is not enough separation on its own', () => {
    const hover = computeHoverRgb(LIGHT, WHITE)
    expect(hover).toEqual({ r: 146, g: 146, b: 146 })
    expect(hover.r, 'must land below the base colour, not above it').toBeLessThan(LIGHT.r)
    expect(contrastRatio(WHITE, hover)).toBeGreaterThanOrEqual(3)
  })

  it('a DARK colour with a white on-primary keeps blending towards white: the original direction was never unsafe here', () => {
    const hover = computeHoverRgb(DARK, WHITE)
    expect(hover).toEqual({ r: 71, g: 71, b: 71 })
    expect(hover.r).toBeGreaterThan(DARK.r)
    expect(contrastRatio(WHITE, hover)).toBeGreaterThanOrEqual(3)
  })

  it('a LIGHT colour with a dark (graphite) on-primary also keeps blending towards white: that direction is safe for this pairing', () => {
    const hover = computeHoverRgb(LIGHT, GRAPHITE)
    expect(hover.r).toBeGreaterThan(LIGHT.r)
    expect(contrastRatio(GRAPHITE, hover)).toBeGreaterThanOrEqual(3)
  })

  it('falls back to the original towards-white behaviour, unconditionally, when on-primary could not be resolved', () => {
    const hover = computeHoverRgb(LIGHT, null)
    const oldFormula = (c) => Math.round(c + (255 - c) * 0.15)
    expect(hover).toEqual({ r: oldFormula(LIGHT.r), g: oldFormula(LIGHT.g), b: oldFormula(LIGHT.b) })
  })

  it('the fix genuinely improves WCAG contrast for the broken case, measured against the exact old value, not assumed', () => {
    const oldFormula = (c) => Math.round(c + (255 - c) * 0.15)
    const oldHover = { r: oldFormula(LIGHT.r), g: oldFormula(LIGHT.g), b: oldFormula(LIGHT.b) }
    const newHover = computeHoverRgb(LIGHT, WHITE)
    const oldRatio = contrastRatio(WHITE, oldHover)
    const newRatio = contrastRatio(WHITE, newHover)
    expect(newRatio, `old ${oldRatio.toFixed(2)}:1, new ${newRatio.toFixed(2)}:1`).toBeGreaterThan(oldRatio * 2)
    expect(newRatio, 'and it must actually clear the WCAG minimum, not just improve on a bad baseline').toBeGreaterThanOrEqual(3)
  })
})
