import { afterEach, describe, expect, it, vi } from 'vitest'
import { maskDocument, boxFromPoints } from '../src/screenshot.js'
import PrGoblin from '../src/index.js'

function page(html) {
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = html
  return doc
}

describe('maskDocument', () => {
  it('blanks form values by default and leaves buttons and checkboxes alone', () => {
    const doc = page(`
      <input id="name" value="Ada Lovelace" placeholder="Your name">
      <textarea id="notes">patient has allergies</textarea>
      <select id="plan"><option selected>Enterprise – ACME Corp</option></select>
      <input id="agree" type="checkbox" checked>
      <input id="go" type="submit" value="Send">
      <p id="text">Visible heading</p>`)
    maskDocument(doc)
    expect(doc.getElementById('name').value).toBe('')
    expect(doc.getElementById('name').getAttribute('placeholder')).toBe('')
    expect(doc.getElementById('notes').value).toBe('')
    expect(doc.getElementById('plan').options[0].textContent).toBe('')
    expect(doc.getElementById('agree').checked).toBe(true)
    expect(doc.getElementById('go').value).toBe('Send')
    expect(doc.getElementById('text').textContent).toBe('Visible heading')
  })

  it('always blocks out marked elements, including other tools\' markers and custom selectors', () => {
    const doc = page(`
      <div id="a" data-goblin-mask>Card 4242 4242 4242 4242</div>
      <div id="b" data-private><span id="b-child">Secret</span></div>
      <div id="c" class="sentry-mask">Sentry</div>
      <td id="d" class="client-cell">Client Ltd</td>
      <div id="e">Not masked</div>`)
    maskDocument(doc, { mask: 'none', maskSelectors: ['.client-cell'] })
    for (const id of ['a', 'b', 'c']) {
      expect(doc.getElementById(id).style.getPropertyValue('color')).toBe('transparent')
    }
    expect(doc.getElementById('b-child').style.getPropertyValue('color')).toBe('transparent')
    expect(doc.getElementById('e').style.getPropertyValue('color')).toBe('')
  })

  it("mask: 'none' leaves form values", () => {
    const doc = page('<input id="q" value="search term">')
    maskDocument(doc, { mask: 'none' })
    expect(doc.getElementById('q').value).toBe('search term')
  })

  it("mask: 'all' makes text unreadable and hides images", () => {
    const doc = page('<h1 id="h">Invoice 2041 for Bob</h1><img id="logo" src="data:image/png;base64,AAAA">')
    maskDocument(doc, { mask: 'all' })
    expect(doc.getElementById('h').textContent).toBe('Xxxxxxx 0000 xxx Xxx')
    expect(doc.getElementById('logo')).toBeNull()
  })
})

describe('boxFromPoints', () => {
  it('normalises any drag direction and clamps to the image', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 }
    expect(boxFromPoints(rect, { x: 300, y: 150 }, { x: 200, y: 100 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
    expect(boxFromPoints(rect, { x: 0, y: 0 }, { x: 150, y: 75 })).toEqual({ x: 0, y: 0, w: 0.25, h: 0.25 })
  })
})

describe('reporter redaction', () => {
  afterEach(() => {
    PrGoblin.destroy()
    vi.restoreAllMocks()
  })

  it('sends no screenshot rather than an unredacted one when blacking out fails', { timeout: 8000 }, async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, issueUrl: 'https://github.com/o/r/issues/1', issueNumber: 1 }), { status: 201 }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const instance = PrGoblin.init({ endpoint: 'https://example.test/feedback' })
    instance._screenshot = 'data:image/png;base64,AAAA'
    instance._setRedactions([{ x: 0, y: 0, w: 0.5, h: 0.5 }])
    expect(document.querySelectorAll('.bp-shot-box').length).toBe(1)

    document.querySelector('#bp-what-happened').value = 'It broke'
    document.querySelector('#bp-expected').value = 'It works'
    document.querySelector('#bp-what-happened').dispatchEvent(new Event('input'))
    document.querySelector('#bp-submit-btn').click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 5000 })
    // jsdom has no canvas, so redaction cannot be applied.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).screenshot).toBeNull()
  })

  it('sends the screenshot unchanged when nothing was blacked out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, issueUrl: 'https://github.com/o/r/issues/1', issueNumber: 1 }), { status: 201 }),
    )
    const instance = PrGoblin.init({ endpoint: 'https://example.test/feedback' })
    instance._screenshot = 'data:image/png;base64,AAAA'
    document.querySelector('#bp-what-happened').value = 'It broke'
    document.querySelector('#bp-expected').value = 'It works'
    document.querySelector('#bp-what-happened').dispatchEvent(new Event('input'))
    document.querySelector('#bp-submit-btn').click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).screenshot).toBe('data:image/png;base64,AAAA')
  })
})
