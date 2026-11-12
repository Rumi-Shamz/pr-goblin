import html2canvas from 'html2canvas'

// What the screenshot hides. The capture is taken from a copy of the page that
// html2canvas makes, so masking changes the copy and never the live page.
//
//   mask: 'fields' (default)  values in inputs, textareas and selects, and every
//                             element matched by a mask selector
//   mask: 'all'               as 'fields', plus all text and all images: only
//                             the layout is left, for layout bugs
//   mask: 'none'              only the mask selectors
//
// The mask selectors always apply. They include the attributes other session
// tools use, so pages already marked up for those are covered as they are.
export const DEFAULT_MASK_SELECTORS = [
  '[data-goblin-mask]',
  '[data-private]',      // LogRocket and others
  '.sentry-mask',        // Sentry session replay
  '.sentry-block',
  '.rr-mask',            // rrweb / PostHog
  '.rr-block',
  '.ph-no-capture',      // PostHog
  '.fs-mask',            // FullStory
  '.fs-exclude',
  'input[type="password"]',
]

const MASK_COLOUR = '#3b3b3b'
const MEDIA = 'img, picture, video, canvas, svg, iframe, object, embed'
const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'image', 'file', 'hidden'])

function maskBox(el) {
  el.style.setProperty('background', MASK_COLOUR, 'important')
  el.style.setProperty('background-image', 'none', 'important')
  el.style.setProperty('color', 'transparent', 'important')
  el.style.setProperty('text-shadow', 'none', 'important')
  el.style.setProperty('border-color', MASK_COLOUR, 'important')
  for (const child of el.querySelectorAll('*')) {
    child.style.setProperty('color', 'transparent', 'important')
    child.style.setProperty('text-shadow', 'none', 'important')
    // CSS backgrounds are images too (avatars, charts, sprites).
    child.style.setProperty('background-image', 'none', 'important')
    if (child.matches(MEDIA)) child.style.setProperty('visibility', 'hidden', 'important')
  }
  if (el.matches(MEDIA)) {
    // A replaced element shows its own pixels over any background: swap it for a block.
    const block = el.ownerDocument.createElement('div')
    const { width, height } = el.getBoundingClientRect?.() ?? { width: 0, height: 0 }
    block.style.cssText = `display:inline-block;width:${width || el.width || 0}px;height:${height || el.height || 0}px;background:${MASK_COLOUR}`
    el.replaceWith(block)
  }
}

function maskField(el) {
  if (el.tagName === 'INPUT' && NON_TEXT_INPUTS.has((el.type || 'text').toLowerCase())) return
  if (el.tagName === 'SELECT') {
    for (const opt of el.options) opt.textContent = ''
  } else {
    el.value = ''
    el.textContent = ''
    el.setAttribute('placeholder', '')
  }
  maskBox(el)
}

function scrambleText(root) {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    // Roughly the same width, unreadable.
    node.nodeValue = node.nodeValue.replace(/\p{Lu}/gu, 'X').replace(/[\p{Ll}\p{Lo}\p{Lt}\p{Lm}]/gu, 'x').replace(/\p{N}/gu, '0')
  }
}

/** Apply masking to a document (the copy html2canvas captures). Exported for tests. */
export function maskDocument(doc, { mask = 'fields', maskSelectors = [] } = {}) {
  const selectors = [...DEFAULT_MASK_SELECTORS, ...maskSelectors].join(', ')
  if (mask !== 'none') {
    doc.querySelectorAll('input, textarea, select').forEach(maskField)
  }
  doc.querySelectorAll(selectors).forEach(maskBox)
  if (mask === 'all') {
    scrambleText(doc.body)
    doc.body.querySelectorAll(MEDIA).forEach(maskBox)
    // CSS background images, on every element including body.
    for (const el of [doc.body, ...doc.body.querySelectorAll('*')]) {
      el.style.setProperty('background-image', 'none', 'important')
    }
  }
}

export async function captureScreenshot(elementsToHide = [], options = {}) {
  // Hide the widget UI before capturing so it doesn't appear in the screenshot
  elementsToHide.forEach((el) => { if (el) el.style.visibility = 'hidden' })

  // Allow the DOM to repaint before capture
  await new Promise((r) => setTimeout(r, 150))

  try {
    const canvas = await html2canvas(document.body, {
      useCORS: true,
      scale: 0.8,
      backgroundColor: '#ffffff',
      removeContainer: true,
      ignoreElements: (el) =>
        el.classList && (
          el.classList.contains('bp-dialog') ||
          el.classList.contains('bp-backdrop') ||
          el.classList.contains('bp-trigger')
        ),
      onclone: (clonedDoc) => maskDocument(clonedDoc, options),
    })
    return canvas.toDataURL('image/png', 0.85)
  } finally {
    elementsToHide.forEach((el) => { if (el) el.style.visibility = '' })
  }
}

/**
 * Paint the reporter's black-out boxes onto the screenshot. Boxes are
 * fractions of the image ({ x, y, w, h } in 0..1). Throws if the image cannot be
 * redacted, so the caller can send no screenshot rather than an unredacted one.
 */
export async function applyRedactions(dataUrl, boxes, timeoutMs = 3000) {
  if (!boxes.length) return dataUrl
  const img = new Image()
  await new Promise((resolve, reject) => {
    // Never let a stuck decode hold up the report.
    const timer = setTimeout(() => reject(new Error('screenshot took too long to load for redaction')), timeoutMs)
    img.onload = () => { clearTimeout(timer); resolve() }
    img.onerror = () => { clearTimeout(timer); reject(new Error('screenshot could not be loaded for redaction')) }
    img.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx || !canvas.width || !canvas.height) throw new Error('no canvas to redact the screenshot')
  ctx.drawImage(img, 0, 0)
  ctx.fillStyle = '#000'
  for (const b of boxes) {
    // Round both edges outward so no strip of the chosen area is left uncovered.
    const x0 = Math.floor(b.x * canvas.width)
    const y0 = Math.floor(b.y * canvas.height)
    const x1 = Math.ceil((b.x + b.w) * canvas.width)
    const y1 = Math.ceil((b.y + b.h) * canvas.height)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
  return canvas.toDataURL('image/png')
}

/** A box from two pointer positions, as fractions of the element's rectangle, clamped to it. */
export function boxFromPoints(rect, a, b) {
  const clamp = (v) => Math.min(Math.max(v, 0), 1)
  const x1 = clamp((a.x - rect.left) / rect.width)
  const y1 = clamp((a.y - rect.top) / rect.height)
  const x2 = clamp((b.x - rect.left) / rect.width)
  const y2 = clamp((b.y - rect.top) / rect.height)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}
