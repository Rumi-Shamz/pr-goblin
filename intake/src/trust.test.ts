import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { isTrustedReporter, signReporter, ticketLabels } from './trust'

const SECRET = 'test-trust-secret'

describe('reporter proof', () => {
  it('matches what a host backend computes with a standard HMAC library', async () => {
    const fromNode = createHmac('sha256', SECRET).update('ada').digest('hex')
    expect(await signReporter('ada', SECRET)).toBe(fromNode)
    expect(await isTrustedReporter('ada', fromNode, SECRET)).toBe(true)
  })

  it('accepts an upper-case hex proof', async () => {
    const proof = (await signReporter('ada', SECRET)).toUpperCase()
    expect(await isTrustedReporter('ada', proof, SECRET)).toBe(true)
  })

  it('rejects a proof minted for a different login', async () => {
    const proof = await signReporter('ada', SECRET)
    expect(await isTrustedReporter('grace', proof, SECRET)).toBe(false)
  })

  it('rejects a proof minted with a different secret', async () => {
    const proof = await signReporter('ada', 'other-secret')
    expect(await isTrustedReporter('ada', proof, SECRET)).toBe(false)
  })

  it('rejects when the secret, login or proof is missing', async () => {
    const proof = await signReporter('ada', SECRET)
    expect(await isTrustedReporter('ada', proof, undefined)).toBe(false)
    expect(await isTrustedReporter(null, proof, SECRET)).toBe(false)
    expect(await isTrustedReporter('ada', '', SECRET)).toBe(false)
  })

  it('rejects malformed proofs instead of throwing', async () => {
    for (const bad of ['zz', 'abc', 'not hex at all', '00']) {
      expect(await isTrustedReporter('ada', bad, SECRET)).toBe(false)
    }
  })
})

describe('ticketLabels', () => {
  it('marks an unverified bug ready but untrusted, so the runner holds it', () => {
    expect(ticketLabels('bug', false)).toEqual(['user-feedback', 'bug', 'goblin', 'untrusted'])
    expect(ticketLabels(undefined, false)).toContain('untrusted')
  })

  it('marks a verified bug ready', () => {
    expect(ticketLabels('bug', true)).toEqual(['user-feedback', 'bug', 'goblin'])
  })

  it('never marks a feature request ready, trusted or not', () => {
    expect(ticketLabels('feature', true)).not.toContain('goblin')
    expect(ticketLabels('feature', false)).not.toContain('goblin')
  })
})
