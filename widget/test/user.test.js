import { afterEach, describe, expect, it, vi } from 'vitest'
import BugPilot from '../src/index.js'
import { sanitiseUser, USER_FIELD_MAX } from '../src/user.js'

const ENDPOINT = 'https://example.test/feedback'

afterEach(() => {
  BugPilot.destroy()
  document.querySelectorAll('.bp-trigger, .bp-dialog, .bp-backdrop').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

function fillAndSubmit() {
  document.querySelector('#bp-what-happened').value = 'It broke'
  document.querySelector('#bp-expected').value = 'It works'
  document.querySelector('#bp-what-happened').dispatchEvent(new Event('input'))
  document.querySelector('#bp-submit-btn').click()
}

describe('user option', () => {
  it('sanitises to plain text, strips angle brackets, caps at 120 chars', () => {
    expect(sanitiseUser({ name: ' <b>Ada</b>  Lovelace ', login: 'ada' })).toEqual({ name: 'bAda/b Lovelace', login: 'ada' })
    expect(sanitiseUser({ name: 'x'.repeat(200) }).name.length).toBe(USER_FIELD_MAX)
    expect(sanitiseUser({ name: 42, login: '' })).toBeNull()
    expect(sanitiseUser('ada')).toBeNull()
    expect(sanitiseUser(undefined)).toBeNull()
    expect(sanitiseUser({ login: 'ada' })).toEqual({ name: null, login: 'ada' })
  })

  it('is carried in the POST payload, and the issue number comes back as a receipt', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, issueUrl: 'https://github.com/o/r/issues/57', issueNumber: 57 }), { status: 201 }),
    )
    BugPilot.init({ endpoint: ENDPOINT, user: { name: 'Ada', login: 'ada' } })
    fillAndSubmit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.user).toEqual({ name: 'Ada', login: 'ada' })
    expect(sent.description).toBe('It broke')
    await vi.waitFor(() => expect(document.querySelector('#bp-status').textContent).toContain('#57'))
    expect(document.querySelector('#bp-status').textContent).toBe('Report submitted as #57. View issue →')
    expect(document.querySelector('#bp-status a').href).toBe('https://github.com/o/r/issues/57')
  })

  it('falls back to the plain receipt when the response has no number', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, issueUrl: 'https://github.com/o/r/issues/3' }), { status: 201 }),
    )
    BugPilot.init({ endpoint: ENDPOINT })
    fillAndSubmit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await vi.waitFor(() => expect(document.querySelector('#bp-status').textContent).toContain('submitted'))
    expect(document.querySelector('#bp-status').textContent).toBe('Report submitted. View issue →')
  })

  it('is null in the payload when not configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ issueUrl: 'https://github.com/o/r/issues/2' }), { status: 201 }),
    )
    BugPilot.init({ endpoint: ENDPOINT })
    fillAndSubmit()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).user).toBeNull()
  })
})
