import { afterEach, describe, expect, it, vi } from 'vitest'
import PrGoblin from '../src/index.js'

const ENDPOINT = 'https://example.test/feedback'

afterEach(() => {
  PrGoblin.destroy()
  document.querySelectorAll('.bp-trigger, .bp-dialog, .bp-backdrop').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

function fillAndSubmit() {
  document.querySelector('#bp-what-happened').value = 'It broke'
  document.querySelector('#bp-expected').value = 'It works'
  document.querySelector('#bp-what-happened').dispatchEvent(new Event('input'))
  document.querySelector('#bp-submit-btn').click()
}

describe('screenshot option', () => {
  it('offers the capture button by default', () => {
    PrGoblin.init({ endpoint: ENDPOINT })
    expect(document.querySelector('#bp-capture-btn')).not.toBeNull()
  })

  it('screenshot: false hides the option, submits without one, and the dialog still resets', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, issueUrl: 'https://github.com/o/r/issues/1', issueNumber: 1 }), { status: 201 }),
    )
    const instance = PrGoblin.init({ endpoint: ENDPOINT, screenshot: false })
    expect(document.querySelector('#bp-capture-btn')).toBeNull()
    expect(document.querySelector('#bp-screenshot-preview')).toBeNull()

    // Even if something sets one, it does not leave the page.
    instance._screenshot = 'data:image/png;base64,AAAA'
    fillAndSubmit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).screenshot).toBeNull()
    await vi.waitFor(() => expect(document.querySelector('#bp-status').textContent).toContain('#1'))
    expect(() => instance._reset()).not.toThrow()
  })
})
