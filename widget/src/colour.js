// Small, pure colour helpers for _applyColor()'s hover-face computation
// (widget.js). Kept separate so the maths is unit-testable without a DOM.

// Parses a browser-computed colour string. getComputedStyle always resolves
// a real CSS property (colour, background-colour, etc.) to `rgb(r, g, b)`
// or `rgba(r, g, b, a)`, whatever var() chain or format the author wrote it
// in, so this only needs to handle that one normalised shape. Returns null
// for anything else (an unset property, an unparsed custom property, a
// keyword like `transparent`) so the caller can fall back safely rather
// than guess.
export function parseRgbString(value) {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value || '')
  if (!match) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

// WCAG relative luminance (the same formula the contrast ratio standard
// uses), 0 (black) to 1 (white).
export function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// WCAG contrast ratio between two colours, 1 (identical) to 21 (black on
// white).
export function contrastRatio(a, b) {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

function blendTowards(base, target, amount) {
  const mix = (c) => Math.round(c + (target - c) * amount)
  return { r: mix(base.r), g: mix(base.g), b: mix(base.b) }
}

const DEFAULT_BLEND = 0.15

// WCAG 2.1 SC 1.4.11 (Non-text Contrast): 3:1 is the minimum for a UI
// component's states against each other, the bar this uses for "the
// default direction is still safe".
const MIN_CONTRAST = 3

// The hover face for a passed `color`. Blending 15% towards white is the
// original, correct-most-of-the-time behaviour (a dark base colour barely
// moves and stays comfortably far from a white icon either way), so it
// stays the default. It was applied unconditionally, though, with no check
// on the result: --bp-on-primary defaults to white, and an already-light
// `color` blended a further 15% towards white landed close enough to white
// that a white icon lost most of its contrast against it - this is what
// the trigger's own icon "almost vanishing" on hover was.
//
// The fix is a measured escape hatch, not a different default direction:
// blend towards white, check the resulting contrast against the resolved
// on-primary colour, and only reach for black instead if that check
// actually fails. A dark base colour (the widget's own default primary
// included) keeps its existing, more visible hover shift; only a base
// colour close enough to on-primary's own lightness for the shift to be
// unsafe changes direction.
//
// A fixed 15% step in the other direction is not always enough separation
// either, for the same reason the original bug existed: a base colour that
// starts close to on-primary needs to move further to reach the same
// absolute contrast a colour that started further away would from the
// same-sized step. So the fallback escalates the blend amount in 5% steps
// until the result actually clears the minimum, capping at a pure black
// target, rather than reusing the original step size in the other
// direction and hoping it is enough.
//
// onPrimary is null when it could not be resolved (see widget.js's
// _applyColor for why that can happen), in which case there is nothing to
// check against and this keeps the original towards-white behaviour,
// unconditionally, which is what every consumer got before this fix.
export function computeHoverRgb(base, onPrimary) {
  const towardsWhite = blendTowards(base, 255, DEFAULT_BLEND)
  if (!onPrimary || contrastRatio(onPrimary, towardsWhite) >= MIN_CONTRAST) return towardsWhite
  for (let amount = DEFAULT_BLEND; amount <= 1; amount += 0.05) {
    const candidate = blendTowards(base, 0, amount)
    if (contrastRatio(onPrimary, candidate) >= MIN_CONTRAST) return candidate
  }
  return blendTowards(base, 0, 1)
}
