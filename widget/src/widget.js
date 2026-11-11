import { captureContext } from './context.js'
import { captureScreenshot } from './screenshot.js'
import cssText from './styles.css?inline'
import { resolveIcon } from './icon.js'
import { DragTracker, SIDES, defaultY, readDock, writeDock } from './dock.js'
import { sanitiseUser } from './user.js'
import { parseRgbString, computeHoverRgb } from './colour.js'

const BUG_CATEGORIES = [
  'UI / Visual issue',
  'Functionality bug',
  'Performance issue',
  'Navigation problem',
  'Data display error',
  'Form / input issue',
  'Other',
]

export class BugPilotWidget {
  constructor(config) {
    this._cfg = {
      position: 'bottom-right',
      triggerLabel: 'Feedback',
      variant: 'pill',
      side: 'right',
      icon: null,
      user: null,
      ...config,
    }
    this._user = sanitiseUser(this._cfg.user)
    if (this._cfg.variant !== 'tab') this._cfg.variant = 'pill'
    if (!SIDES.has(this._cfg.side)) this._cfg.side = 'right'
    this._type = 'bug'
    this._screenshot = null
    this._submitting = false
    this._autoCloseTimer = null
    this._inject()
    this._render()
    this._applyColor()
    this._bind()
  }

  _inject() {
    if (document.getElementById('bp-styles')) return
    const style = document.createElement('style')
    style.id = 'bp-styles'
    style.textContent = cssText
    document.head.appendChild(style)
  }

  _applyColor() {
    const color = this._cfg.color
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)

    // Hover face: computeHoverRgb blends away from --bp-on-primary's own
    // lightness rather than unconditionally towards white (colour.js has
    // the full reasoning and is where this is unit-tested; the DOM part
    // below is deliberately thin). Read via the trigger's own computed
    // `color` (a real CSS property, whose value getComputedStyle always
    // fully resolves through any var() chain) rather than reading
    // --bp-on-primary as a custom property directly, which is not
    // guaranteed to have its own var() chain substituted when read back
    // that way, even when the host's override is itself a var() reference.
    const onPrimary = parseRgbString(getComputedStyle(this._trigger).color)
    const { r: hr, g: hg, b: hb } = computeHoverRgb({ r, g, b }, onPrimary)

    for (const el of [this._trigger, this._dialog]) {
      el.style.setProperty('--bp-primary', color)
      el.style.setProperty('--bp-primary-hover', `rgb(${hr}, ${hg}, ${hb})`)
      el.style.setProperty('--bp-primary-shadow', `rgba(${r}, ${g}, ${b}, 0.32)`)
      el.style.setProperty('--bp-primary-soft', `rgba(${r}, ${g}, ${b}, 0.06)`)
    }
  }

  _render() {
    const VALID_POSITIONS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
    const pos = VALID_POSITIONS.has(this._cfg.position) ? this._cfg.position : 'bottom-right'

    const isTab = this._cfg.variant === 'tab'
    const icon = resolveIcon(this._cfg.icon, this._cfg.variant)

    this._trigger = document.createElement('button')
    this._trigger.type = 'button'
    this._trigger.setAttribute('aria-label', 'Open feedback form')
    if (isTab) {
      // Outer button is the 44px hit area; the inner face is the visible
      // 36px square docked against the viewport edge.
      this._trigger.className = 'bp-trigger bp-trigger--tab'
      const face = document.createElement('span')
      face.className = 'bp-tab-face'
      face.innerHTML = icon
      this._trigger.appendChild(face)
    } else {
      this._trigger.className = `bp-trigger bp-trigger--pill bp-trigger--${pos}`
      const iconWrap = document.createElement('span')
      iconWrap.className = 'bp-trigger-icon'
      iconWrap.innerHTML = icon
      this._trigger.appendChild(iconWrap)
      const triggerLabel = document.createElement('span')
      triggerLabel.textContent = this._cfg.triggerLabel
      this._trigger.appendChild(triggerLabel)
    }

    this._backdrop = document.createElement('div')
    this._backdrop.className = 'bp-backdrop'
    this._backdrop.setAttribute('aria-hidden', 'true')

    this._dialog = document.createElement('div')
    this._dialog.className = isTab ? 'bp-dialog bp-dialog--tab' : `bp-dialog bp-dialog--${pos}`
    this._dialog.setAttribute('role', 'dialog')
    this._dialog.setAttribute('aria-modal', 'true')
    this._dialog.setAttribute('aria-labelledby', 'bp-dialog-title')
    this._dialog.innerHTML = this._dialogHTML()

    document.body.appendChild(this._backdrop)
    document.body.appendChild(this._dialog)
    document.body.appendChild(this._trigger)

    // Bug field refs
    this._bugCategoryEl  = this._dialog.querySelector('#bp-bug-category')
    this._whatHappenedEl = this._dialog.querySelector('#bp-what-happened')
    this._expectedEl     = this._dialog.querySelector('#bp-expected')
    this._stepsEl        = this._dialog.querySelector('#bp-steps')
    this._frequencyEl    = this._dialog.querySelector('#bp-frequency')
    this._impactEl       = this._dialog.querySelector('#bp-impact')
    // Feature field refs
    this._featureAskEl      = this._dialog.querySelector('#bp-feature-ask')
    this._featureWhyEl      = this._dialog.querySelector('#bp-feature-why')
    this._featurePriorityEl = this._dialog.querySelector('#bp-feature-priority')
    // Common refs
    this._screenshotPreview = this._dialog.querySelector('#bp-screenshot-preview')
    this._captureBtn        = this._dialog.querySelector('#bp-capture-btn')
    this._submitBtn         = this._dialog.querySelector('#bp-submit-btn')
    this._statusEl          = this._dialog.querySelector('#bp-status')

    this._populateContext()
    if (isTab) this._initDock()
  }

  // --- Tab variant: edge docking, drag along the edge, side swap ---------

  _storage() {
    try { return window.localStorage } catch { return null }
  }

  _initDock() {
    const vh = window.innerHeight
    const stored = readDock(this._storage(), window.location.origin, vh)
    this._dock = new DragTracker({
      side: stored ? stored.side : this._cfg.side,
      y: stored ? stored.y : defaultY(vh),
      viewportWidth: window.innerWidth,
      viewportHeight: vh,
    })
    this._suppressClick = false
    this._applyDock()

    this._onResize = () => {
      this._dock.resize(window.innerWidth, window.innerHeight)
      this._applyDock()
    }
    window.addEventListener('resize', this._onResize)
  }

  _applyDock() {
    const { side, y } = this._dock
    this._trigger.classList.toggle('bp-trigger--left', side === 'left')
    this._trigger.classList.toggle('bp-trigger--right', side === 'right')
    this._dialog.classList.toggle('bp-dialog--left', side === 'left')
    this._dialog.classList.toggle('bp-dialog--right', side === 'right')
    this._trigger.style.top = `${y}px`
    this._trigger.style.transform = ''
    this._trigger.setAttribute('data-bp-side', side)
  }

  // Settle the trigger onto its edge after a drag. If the side changed, the
  // element is re-anchored to the other edge, so its current on-screen x is
  // re-expressed as an offset from the new rest position and then cleared,
  // which lets the CSS transform transition carry it across (no transition
  // under prefers-reduced-motion, so it simply jumps).
  _snapTo(result) {
    const t = this._trigger
    const before = t.getBoundingClientRect?.()
    this._applyDock()
    if (!before || typeof requestAnimationFrame !== 'function') return
    const restLeft = result.side === 'left' ? 0 : window.innerWidth - before.width
    const dx = before.left - restLeft
    if (!dx) return
    t.classList.add('bp-trigger--dragging')
    t.style.transform = `translateX(${dx}px)`
    void t.offsetWidth
    t.classList.remove('bp-trigger--dragging')
    requestAnimationFrame(() => { t.style.transform = '' })
  }

  _bindDock() {
    const t = this._trigger
    this._onPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return
      this._dock.start(e.clientX, e.clientY)
      this._pointerId = e.pointerId
      t.setPointerCapture?.(e.pointerId)
    }
    this._onPointerMove = (e) => {
      if (this._pointerId !== undefined && e.pointerId !== this._pointerId) return
      const frame = this._dock.move(e.clientX, e.clientY)
      if (!frame) return
      if (!t.classList.contains('bp-trigger--dragging')) t.classList.add('bp-trigger--dragging')
      t.style.top = `${frame.y}px`
      t.style.transform = `translateX(${frame.dx}px)`
      e.preventDefault()
    }
    this._onPointerUp = (e) => {
      if (this._pointerId !== undefined && e.pointerId !== this._pointerId) return
      this._pointerId = undefined
      const result = this._dock.end()
      t.classList.remove('bp-trigger--dragging')
      if (!result.wasDrag) return   // the click event that follows opens the dialog
      // A drag must not also fire the click that the browser dispatches
      // after pointerup on the same element.
      this._suppressClick = true
      this._snapTo(result)
      writeDock(this._storage(), window.location.origin, result)
    }
    this._onPointerCancel = (e) => {
      if (this._pointerId !== undefined && e.pointerId !== this._pointerId) return
      this._pointerId = undefined
      this._dock.cancel()
      t.classList.remove('bp-trigger--dragging')
      this._applyDock()
    }
    t.addEventListener('pointerdown', this._onPointerDown)
    t.addEventListener('pointermove', this._onPointerMove)
    t.addEventListener('pointerup', this._onPointerUp)
    t.addEventListener('pointercancel', this._onPointerCancel)
  }

  _dialogHTML() {
    return `
      <div class="bp-header">
        <h2 id="bp-dialog-title">Report a bug</h2>
        <button class="bp-close" id="bp-close-btn" aria-label="Close feedback form">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="bp-body">
        <div class="bp-type-picker">
          <button class="bp-type-btn bp-type-btn--active" data-type="bug" type="button">Bug / Usability</button>
          <button class="bp-type-btn" data-type="feature" type="button">Feature / Feedback</button>
        </div>

        <div id="bp-fields-bug">
          <div class="bp-field">
            <label class="bp-label" for="bp-bug-category">Category</label>
            <select class="bp-select" id="bp-bug-category">
              <option value="">Select a category…</option>
              ${BUG_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div class="bp-field">
            <label class="bp-label" for="bp-what-happened">What happened? <span>(required)</span></label>
            <textarea class="bp-textarea" id="bp-what-happened" placeholder="Describe what went wrong. What did you see?" rows="3"></textarea>
          </div>
          <div class="bp-field">
            <label class="bp-label" for="bp-expected">Expected behaviour <span>(required)</span></label>
            <textarea class="bp-textarea" id="bp-expected" placeholder="What should have happened instead?" rows="2"></textarea>
          </div>
          <div class="bp-field">
            <label class="bp-label" for="bp-steps">Steps to reproduce <span>(optional)</span></label>
            <textarea class="bp-textarea" id="bp-steps" placeholder="1. Go to…&#10;2. Click…&#10;3. See error" rows="3"></textarea>
          </div>
          <div class="bp-field-row">
            <div class="bp-field">
              <label class="bp-label" for="bp-frequency">How often?</label>
              <select class="bp-select" id="bp-frequency">
                <option value="every-time">Every time</option>
                <option value="most-times">Most of the time</option>
                <option value="sometimes">Occasionally</option>
                <option value="once">Just once</option>
              </select>
            </div>
            <div class="bp-field">
              <label class="bp-label" for="bp-impact">Impact</label>
              <select class="bp-select" id="bp-impact">
                <option value="blocking">Blocking</option>
                <option value="degraded">Degraded</option>
                <option value="cosmetic">Cosmetic</option>
              </select>
            </div>
          </div>
        </div>

        <div id="bp-fields-feature" class="bp-fields--hidden">
          <div class="bp-field">
            <label class="bp-label" for="bp-feature-ask">What would you like? <span>(required)</span></label>
            <textarea class="bp-textarea" id="bp-feature-ask" placeholder="Describe the feature or improvement you'd like to see." rows="3"></textarea>
          </div>
          <div class="bp-field">
            <label class="bp-label" for="bp-feature-why">Why do you need it? <span>(optional)</span></label>
            <textarea class="bp-textarea" id="bp-feature-why" placeholder="What problem does this solve? Who else would benefit?" rows="2"></textarea>
          </div>
          <div class="bp-field">
            <label class="bp-label" for="bp-feature-priority">Priority to you</label>
            <select class="bp-select" id="bp-feature-priority">
              <option value="critical">Critical to my workflow</option>
              <option value="high">Would significantly help</option>
              <option value="nice">Nice to have</option>
            </select>
          </div>
        </div>

        <div class="bp-field">
          <span class="bp-label">Screenshot <span>(optional)</span></span>
          <div class="bp-screenshot-row">
            <button class="bp-btn-ghost" id="bp-capture-btn" type="button">Capture screenshot</button>
          </div>
          <img class="bp-screenshot-preview" id="bp-screenshot-preview" alt="Screenshot preview" />
        </div>
        <div class="bp-field">
          <span class="bp-label">Context</span>
          <div class="bp-context" id="bp-context-chips"></div>
        </div>
        <div class="bp-status" id="bp-status" role="alert"></div>
      </div>
      <div class="bp-footer">
        <button class="bp-btn-primary" id="bp-submit-btn" type="button" disabled>Submit report</button>
      </div>
    `
  }

  _populateContext() {
    const ctx = captureContext()
    const chips = this._dialog.querySelector('#bp-context-chips')
    const fields = [
      ctx.browser,
      ctx.os,
      `${ctx.viewport.w}×${ctx.viewport.h}`,
      new URL(ctx.url).pathname,
    ]
    chips.textContent = ''
    fields.forEach((f) => {
      const span = document.createElement('span')
      span.className = 'bp-chip'
      span.textContent = f
      chips.appendChild(span)
    })
  }

  _onTypeChange(type) {
    this._type = type
    this._dialog.querySelector('#bp-dialog-title').textContent =
      type === 'bug' ? 'Report a bug' : 'Feature / Feedback'
    this._dialog.querySelectorAll('.bp-type-btn').forEach((btn) => {
      btn.classList.toggle('bp-type-btn--active', btn.dataset.type === type)
    })
    this._dialog.querySelector('#bp-fields-bug').classList.toggle('bp-fields--hidden', type !== 'bug')
    this._dialog.querySelector('#bp-fields-feature').classList.toggle('bp-fields--hidden', type !== 'feature')
    this._updateSubmit()
  }

  _bind() {
    this._trigger.addEventListener('click', () => {
      if (this._suppressClick) { this._suppressClick = false; return }
      // Toggle, not open: the trigger stays reachable above the backdrop,
      // so a second press on it must close the dialog like the X does.
      if (this._isOpen) this.close()
      else this.open()
    })
    if (this._dock) this._bindDock()
    this._dialog.querySelector('#bp-close-btn').addEventListener('click', () => this.close())
    this._backdrop.addEventListener('click', () => this.close())

    this._dialog.querySelectorAll('.bp-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._onTypeChange(btn.dataset.type))
    })

    this._whatHappenedEl.addEventListener('input', () => this._updateSubmit())
    this._expectedEl.addEventListener('input', () => this._updateSubmit())
    this._featureAskEl.addEventListener('input', () => this._updateSubmit())

    this._captureBtn.addEventListener('click', async () => {
      this._captureBtn.disabled = true
      this._captureBtn.textContent = 'Capturing…'
      try {
        this._screenshot = await captureScreenshot([
          this._dialog,
          this._backdrop,
          this._trigger,
        ])
        this._screenshotPreview.src = this._screenshot
        this._screenshotPreview.classList.add('bp-visible')
        this._captureBtn.textContent = 'Retake screenshot'
      } catch (err) {
        this._captureBtn.textContent = 'Capture failed — retry'
        console.error('[bugpilot] screenshot capture failed', err)
      } finally {
        this._captureBtn.disabled = false
      }
    })

    this._submitBtn.addEventListener('click', () => this._submit())

    this._onKeydown = (e) => { if (e.key === 'Escape' && this._isOpen) this.close() }
    document.addEventListener('keydown', this._onKeydown)
  }

  _updateSubmit() {
    let ready
    if (this._type === 'bug') {
      ready = this._whatHappenedEl.value.trim().length > 0 && this._expectedEl.value.trim().length > 0
    } else {
      ready = this._featureAskEl.value.trim().length > 0
    }
    this._submitBtn.disabled = !ready || this._submitting
  }

  async _submit() {
    if (this._submitting) return
    this._submitting = true
    this._submitBtn.disabled = true
    this._submitBtn.textContent = 'Sending…'
    this._statusEl.className = 'bp-status'
    this._statusEl.textContent = ''

    const ctx = captureContext()
    const base = {
      type: this._type,
      screenshot: this._screenshot,
      context: ctx,
      projectName: this._cfg.projectName || document.title,
      user: this._user,
    }

    const payload = this._type === 'bug'
      ? {
          ...base,
          description: this._whatHappenedEl.value.trim(),
          bugCategory: this._bugCategoryEl.value || null,
          expectedBehavior: this._expectedEl.value.trim(),
          stepsToReproduce: this._stepsEl.value.trim() || null,
          frequency: this._frequencyEl.value,
          impact: this._impactEl.value,
        }
      : {
          ...base,
          description: this._featureAskEl.value.trim(),
          problemStatement: this._featureWhyEl.value.trim() || null,
          priority: this._featurePriorityEl.value,
        }

    try {
      const res = await fetch(this._cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }

      const { issueUrl, issueNumber } = await res.json()
      this._showStatus(
        'success',
        issueUrl && /^https:\/\/github\.com\//.test(issueUrl) ? issueUrl : null,
        Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
      )
      this._reset()
      this._autoCloseTimer = setTimeout(() => this.close(), 3000)
    } catch (err) {
      this._showError(`Failed to submit: ${err.message}`)
      console.error('[bugpilot] submit failed', err)
    } finally {
      this._submitting = false
      this._submitBtn.textContent = 'Submit report'
      this._updateSubmit()
    }
  }

  // The issue number is the reporter's receipt: it is what they quote back
  // and what a host "my reports" page keys on.
  _showStatus(type, issueUrl, issueNumber) {
    this._statusEl.className = `bp-status bp-status--${type} bp-visible`
    this._statusEl.textContent = ''
    const msg = document.createTextNode(issueNumber ? `Report submitted as #${issueNumber}. ` : 'Report submitted. ')
    this._statusEl.appendChild(msg)
    if (issueUrl) {
      const a = document.createElement('a')
      a.href = issueUrl
      a.textContent = 'View issue →'
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      this._statusEl.appendChild(a)
    }
  }

  _showError(message) {
    this._statusEl.className = 'bp-status bp-status--error bp-visible'
    this._statusEl.textContent = message
  }

  _reset() {
    this._bugCategoryEl.value = ''
    this._whatHappenedEl.value = ''
    this._expectedEl.value = ''
    this._stepsEl.value = ''
    this._frequencyEl.value = 'every-time'
    this._impactEl.value = 'blocking'
    this._featureAskEl.value = ''
    this._featureWhyEl.value = ''
    this._featurePriorityEl.value = 'critical'
    this._screenshot = null
    this._screenshotPreview.src = ''
    this._screenshotPreview.classList.remove('bp-visible')
    this._captureBtn.textContent = 'Capture screenshot'
    this._updateSubmit()
  }

  open() {
    this._isOpen = true
    this._dialog.classList.add('bp-visible')
    this._backdrop.classList.add('bp-visible')
    const firstField = this._type === 'bug' ? this._whatHappenedEl : this._featureAskEl
    firstField.focus()
  }

  close() {
    clearTimeout(this._autoCloseTimer)
    this._autoCloseTimer = null
    this._isOpen = false
    this._dialog.classList.remove('bp-visible')
    this._backdrop.classList.remove('bp-visible')
    this._statusEl.className = 'bp-status'
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeydown)
    if (this._onResize) window.removeEventListener('resize', this._onResize)
    this._trigger?.remove()
    this._dialog?.remove()
    this._backdrop?.remove()
    document.getElementById('bp-styles')?.remove()
  }
}
