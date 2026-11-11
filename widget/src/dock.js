// Edge-docked tab: persistence and the drag state machine.
//
// Kept free of DOM so it can be unit-tested without a browser. The widget
// feeds it pointer coordinates and applies whatever it returns.

export const SIDES = new Set(['left', 'right'])
export const DRAG_THRESHOLD = 6   // px of movement before a tap becomes a drag
export const HIT = 44             // px, WCAG 2.5.8 minimum target size

// One key per origin. localStorage is already partitioned by origin, but the
// origin in the key means a host serving two apps from one origin under
// different paths still gets one shared position, and a copied value from
// another origin is obviously foreign.
export function storageKey(origin) {
  return `bugpilot.tab:${origin}`
}

export function clampY(y, viewportHeight) {
  const max = Math.max(0, viewportHeight - HIT)
  return Math.min(max, Math.max(0, y))
}

export function defaultY(viewportHeight) {
  return clampY(Math.round((viewportHeight - HIT) / 2), viewportHeight)
}

// Returns { side, y } or null. Never throws: a missing, blocked, or corrupt
// store must render the same as first visit.
export function readDock(storage, origin, viewportHeight) {
  try {
    const raw = storage.getItem(storageKey(origin))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (!SIDES.has(parsed.side)) return null
    if (typeof parsed.y !== 'number' || !Number.isFinite(parsed.y)) return null
    return { side: parsed.side, y: clampY(parsed.y, viewportHeight) }
  } catch {
    // Swallowed on purpose: storage can be absent (privacy mode, blocked
    // site data) or hold rubbish. Either way the fallback is the default
    // dock position, which is the only thing the caller needs.
    return null
  }
}

export function writeDock(storage, origin, dock) {
  try {
    storage.setItem(storageKey(origin), JSON.stringify({ side: dock.side, y: dock.y }))
    return true
  } catch {
    // Quota, private mode, or no storage at all. Position simply does not
    // persist across loads; nothing else depends on the write.
    return false
  }
}

// Pure drag state machine. Feed it start/move/end with client coordinates.
export class DragTracker {
  constructor({ side, y, viewportWidth, viewportHeight }) {
    this.side = side
    this.y = y
    this.vw = viewportWidth
    this.vh = viewportHeight
    this.active = false
    this.dragging = false
  }

  start(clientX, clientY) {
    this.active = true
    this.dragging = false
    this.startX = clientX
    this.startY = clientY
    this.startTop = this.y
    this.lastX = clientX
  }

  // Returns null until the threshold is crossed, then { y, dx } for the
  // caller to render. dx is the horizontal offset from the rest position
  // (negative moves left), so the tab follows the finger across the screen.
  move(clientX, clientY) {
    if (!this.active) return null
    const dx = clientX - this.startX
    const dy = clientY - this.startY
    if (!this.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return null
      this.dragging = true
    }
    this.lastX = clientX
    this.y = clampY(this.startTop + dy, this.vh)
    return { y: this.y, dx }
  }

  // Returns { wasDrag, side, y, swapped }. A tap (never crossed the
  // threshold) reports wasDrag: false so the caller can open the dialog.
  end() {
    const wasDrag = this.dragging
    this.active = false
    this.dragging = false
    if (!wasDrag) return { wasDrag: false, side: this.side, y: this.y, swapped: false }
    const mid = this.vw / 2
    const crossed = this.side === 'right' ? this.lastX < mid : this.lastX > mid
    if (crossed) this.side = this.side === 'right' ? 'left' : 'right'
    return { wasDrag: true, side: this.side, y: this.y, swapped: crossed }
  }

  cancel() {
    this.active = false
    this.dragging = false
    this.y = this.startTop ?? this.y
  }

  resize(viewportWidth, viewportHeight) {
    this.vw = viewportWidth
    this.vh = viewportHeight
    this.y = clampY(this.y, viewportHeight)
    return this.y
  }
}
