// Auto-theme: make the widget look like the page it is embedded in.
//
// Two halves:
//   readHost()   — thin DOM part. Reads the host page's colours, font and
//                  corner radius from its design tokens or rendered elements.
//   buildTheme() — pure part. Turns those few facts into --bp-* variables.
//
// Nothing here throws: a page that gives no usable signal simply keeps the
// widget's own grayscale defaults.

import { parseRgbString, contrastRatio, computeHoverRgb } from './colour.js'

// The stylesheet defaults for every variable auto-theme may set. Used to tell
// "the host overrode this in its own CSS" (leave it alone) from "still the
// default" (safe to theme). Keep in step with styles.css; a test checks it.
export const THEMED_DEFAULTS = {
  '--bp-primary': '#262626',
  '--bp-primary-hover': '#404040',
  '--bp-primary-soft': 'rgba(0, 0, 0, 0.05)',
  '--bp-surface': '#ffffff',
  '--bp-surface-raised': '#fafafa',
  '--bp-border': '#e5e5e5',
  '--bp-text': '#171717',
  '--bp-text-muted': '#737373',
  '--bp-on-primary': '#ffffff',
  '--bp-radius': '12px',
  '--bp-radius-sm': '6px',
  '--bp-radius-xs': '4px',
  '--bp-font': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
}

// Design-token names for the brand colour, most specific first. Covers
// shadcn/ui, Tailwind themes, Bootstrap, MUI, Mantine, Chakra, Radix Themes
// and common hand-rolled names.
const PRIMARY_TOKENS = [
  '--primary', '--color-primary', '--primary-color', '--brand', '--color-brand', '--brand-color',
  '--bs-primary', '--mui-palette-primary-main', '--mantine-primary-color-filled',
  '--chakra-colors-brand-500', '--accent-9', '--color-accent', '--accent-color', '--accent',
]
const RADIUS_TOKENS = ['--radius', '--border-radius', '--bs-border-radius', '--mui-shape-borderRadius', '--mantine-radius-default', '--rounded-btn']

// A token may hold a full colour ("#b45309", "oklch(…)") or bare channels
// meant to be wrapped by the author ("26 75% 37%" in shadcn/ui).
const COLOUR_WRAPPERS = [(v) => `var(${v})`, (v) => `hsl(var(${v}))`, (v) => `oklch(var(${v}))`, (v) => `rgb(var(${v}))`]

const BUTTON_SELECTOR = [
  'button[type="submit"]', '.btn-primary', '.button-primary', '.MuiButton-containedPrimary',
  '[data-variant="default"]', '[data-variant="primary"]', '[class*="primary"]', 'button', '[role="button"]', 'a',
].join(',')
const MAX_CANDIDATES = 40

const WHITE = { r: 255, g: 255, b: 255 }
const NEAR_BLACK = { r: 23, g: 23, b: 23 }

export const rgbCss = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`
const rgbaCss = ({ r, g, b }, a) => `rgba(${r}, ${g}, ${b}, ${a})`

export function mix(a, b, amount) {
  const m = (x, y) => Math.round(x + (y - x) * amount)
  return { r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b) }
}

/** 0 (grey) to 1 (fully saturated); used to tell a brand colour from a neutral one. */
export function saturation({ r, g, b }) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

function alphaOf(value) {
  const m = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)/.exec(value || '')
  return m ? Number(m[1]) : 1
}

let _canvasCtx
/**
 * A computed colour string → {r,g,b}, or null when transparent/unreadable.
 * Browsers report modern colour spaces (oklch, color(), lab) as written, so
 * those go through a canvas, which always paints sRGB.
 */
export function toRgb(value, doc = document) {
  if (!value) return null
  const v = String(value).trim()
  if (!v || v === 'transparent') return null
  const direct = parseRgbString(v)
  if (direct) return alphaOf(v) < 0.5 ? null : direct
  try {
    if (_canvasCtx === undefined) {
      const canvas = doc.createElement('canvas')
      canvas.width = canvas.height = 1
      _canvasCtx = canvas.getContext?.('2d', { willReadFrequently: true }) || null
    }
    if (!_canvasCtx) return null
    _canvasCtx.clearRect(0, 0, 1, 1)
    _canvasCtx.fillStyle = '#000'
    _canvasCtx.fillStyle = v
    _canvasCtx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = _canvasCtx.getImageData(0, 0, 1, 1).data
    return a < 128 ? null : { r, g, b }
  } catch {
    return null
  }
}

function hasToken(rootStyle, name) {
  return rootStyle.getPropertyValue(name).trim() !== ''
}

function tokenColour(doc, rootStyle, probe) {
  const view = doc.defaultView
  for (const name of PRIMARY_TOKENS) {
    if (!hasToken(rootStyle, name)) continue
    for (const wrap of COLOUR_WRAPPERS) {
      probe.style.backgroundColor = ''
      probe.style.backgroundColor = wrap(name)
      const rgb = toRgb(view.getComputedStyle(probe).backgroundColor, doc)
      if (rgb) return rgb
    }
  }
  return null
}

function tokenRadius(doc, rootStyle, probe) {
  const view = doc.defaultView
  for (const name of RADIUS_TOKENS) {
    if (!hasToken(rootStyle, name)) continue
    probe.style.borderTopLeftRadius = ''
    probe.style.borderTopLeftRadius = `var(${name})`
    const px = parseFloat(view.getComputedStyle(probe).borderTopLeftRadius)
    if (Number.isFinite(px)) return px
  }
  return null
}

function isOurs(el) {
  return !!el.closest?.('.bp-trigger, .bp-dialog, .bp-backdrop')
}

/** The most brand-like filled button on the page: colour and corner radius. */
function fromButtons(doc) {
  const view = doc.defaultView
  let best = null
  let seen = 0
  for (const el of doc.querySelectorAll(BUTTON_SELECTOR)) {
    if (isOurs(el)) continue
    if (++seen > MAX_CANDIDATES) break
    const cs = view.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const bg = toRgb(cs.backgroundColor, doc)
    if (!bg) continue
    const score = saturation(bg)
    if (!best || score > best.score) best = { score, colour: bg, radius: parseFloat(cs.borderTopLeftRadius) }
    if (score > 0.35) break
  }
  return best
}

function pageBackground(doc) {
  const view = doc.defaultView
  for (const el of [doc.body, doc.documentElement]) {
    if (!el) continue
    const rgb = toRgb(view.getComputedStyle(el).backgroundColor, doc)
    if (rgb) return rgb
  }
  return null
}

/**
 * Read what the host page looks like. Every field may be null/undefined.
 * Reads computed values, so it follows the page's current light/dark mode.
 */
export function readHost(doc = document) {
  const out = { primary: null, surface: null, text: null, font: null, radius: null }
  try {
    const view = doc.defaultView
    if (!view || !doc.body) return out
    const rootStyle = view.getComputedStyle(doc.documentElement)
    const bodyStyle = view.getComputedStyle(doc.body)

    const probe = doc.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;visibility:hidden'
    doc.body.appendChild(probe)
    let button = null
    try {
      out.primary = tokenColour(doc, rootStyle, probe)
      out.radius = tokenRadius(doc, rootStyle, probe)
      if (!out.primary || out.radius === null) button = fromButtons(doc)
    } finally {
      probe.remove()
    }
    if (!out.primary && button && button.score > 0.15) out.primary = button.colour
    if (out.radius === null && button && Number.isFinite(button.radius)) out.radius = button.radius

    out.surface = pageBackground(doc)
    out.text = toRgb(bodyStyle.color, doc)
    const font = (bodyStyle.fontFamily || '').trim()
    if (font) out.font = font
  } catch {
    // An unreadable page keeps the defaults.
  }
  return out
}

/**
 * Host facts → --bp-* variables. Pure. Only returns variables it has a
 * basis for, so missing facts fall through to the stylesheet defaults.
 */
export function buildTheme({ primary, surface, text, font, radius } = {}) {
  const vars = {}

  // A surface and a text colour that cannot be read against each other
  // (a transparent body over an image, say) are worse than the defaults.
  const readable = surface && text && contrastRatio(surface, text) >= 4.5
  const bg = readable ? surface : null
  const fg = readable ? text : null
  if (bg) {
    vars['--bp-surface'] = rgbCss(bg)
    vars['--bp-surface-raised'] = rgbCss(mix(bg, fg, 0.03))
    vars['--bp-border'] = rgbCss(mix(bg, fg, 0.14))
    vars['--bp-text'] = rgbCss(fg)
    // The lightest mix that still clears WCAG AA for normal text.
    let muted = fg
    for (const amount of [0.45, 0.35, 0.25, 0.15]) {
      const candidate = mix(fg, bg, amount)
      if (contrastRatio(candidate, bg) >= 4.5) { muted = candidate; break }
    }
    vars['--bp-text-muted'] = rgbCss(muted)
  }

  // The brand colour must stand out from the surface the dialog sits on;
  // otherwise use the text colour, which is how the default theme works.
  const against = bg || WHITE
  let brand = primary && contrastRatio(primary, against) >= 1.6 ? primary : null
  if (!brand && fg) brand = fg
  if (brand) {
    const on = contrastRatio(WHITE, brand) >= contrastRatio(NEAR_BLACK, brand) ? WHITE : NEAR_BLACK
    vars['--bp-primary'] = rgbCss(brand)
    vars['--bp-on-primary'] = rgbCss(on)
    vars['--bp-primary-hover'] = rgbCss(computeHoverRgb(brand, on))
    vars['--bp-primary-shadow'] = rgbaCss(brand, 0.32)
    vars['--bp-primary-soft'] = rgbaCss(brand, 0.08)
  }

  if (font) vars['--bp-font'] = font

  if (Number.isFinite(radius) && radius >= 0) {
    // Fields follow the host's control radius; the dialog is a larger
    // surface, so it gets a proportionally larger corner. Pill-shaped
    // buttons (huge radius) must not turn text areas into ovals.
    const control = Math.min(radius, 12)
    vars['--bp-radius-sm'] = `${control}px`
    vars['--bp-radius-xs'] = `${Math.min(control, 4)}px`
    vars['--bp-radius'] = `${Math.min(Math.round(control * 1.5), 16)}px`
  }
  return vars
}

// The defaults as the browser sees them. The build minifies the stylesheet
// ("#ffffff" becomes "#fff"), so read them back from the injected sheet and
// only fall back to the source values when it cannot be read.
function builtDefaults(doc) {
  const defaults = { ...THEMED_DEFAULTS }
  try {
    const rules = doc.getElementById('bp-styles')?.sheet?.cssRules || []
    for (const rule of rules) {
      if (rule.selectorText !== ':root' || !rule.style) continue
      for (const name of Object.keys(defaults)) {
        const value = rule.style.getPropertyValue(name).trim()
        if (value) defaults[name] = value
      }
    }
  } catch {
    // keep the source values
  }
  return defaults
}

/** Variables the host set itself in CSS; auto-theme must not override them. */
export function hostOverrides(doc = document) {
  const overridden = new Set()
  try {
    const rootStyle = doc.defaultView.getComputedStyle(doc.documentElement)
    for (const [name, def] of Object.entries(builtDefaults(doc))) {
      const value = rootStyle.getPropertyValue(name).trim()
      if (value && value !== def) overridden.add(name)
    }
  } catch {
    // none
  }
  return overridden
}

/** Full pipeline: the variables to set on the widget's elements right now. */
export function detectTheme(doc = document, { color } = {}) {
  const host = readHost(doc)
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    host.primary = { r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16) }
  }
  const vars = buildTheme(host)
  const skip = hostOverrides(doc)
  for (const name of Object.keys(vars)) {
    if (skip.has(name)) delete vars[name]
  }
  // A host that pinned the brand colour itself also owns its companions.
  if (skip.has('--bp-primary')) {
    for (const name of ['--bp-primary-hover', '--bp-primary-shadow', '--bp-primary-soft', '--bp-on-primary']) delete vars[name]
  }
  return vars
}
