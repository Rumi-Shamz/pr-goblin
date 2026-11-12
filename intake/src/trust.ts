// trust.ts — deciding whether a report comes from someone the team trusts.
//
// The /feedback endpoint is public, and everything the browser sends can be
// forged, including the `user` object. So "this is one of our testers" has to
// be proven with something the browser cannot make up on its own.
//
// The host app's own backend holds TRUST_SECRET and, for a signed-in tester,
// hands the page a proof: the hex HMAC-SHA256 of the user's login. The widget
// forwards { login, proof }; this endpoint, holding the same secret, checks it.
//
//   proof = hex( HMAC-SHA256( key = TRUST_SECRET, message = login ) )
//
// A report without a valid proof is still accepted, but is labelled
// `untrusted`, which keeps code-writing agents away from it until a human
// has looked (see runner/src/kernel/policy.ts).

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  )
}

/** What the host backend computes. Exported so hosts written in TypeScript can reuse it, and for tests. */
export async function signReporter(login: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(login))
  return bytesToHex(new Uint8Array(sig))
}

/** Never throws. False for a missing secret, login or proof, or a proof that does not match. */
export async function isTrustedReporter(
  login: string | null | undefined,
  proof: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean> {
  if (!secret || !login || !proof) return false
  const sig = hexToBytes(proof)
  if (!sig) return false
  try {
    // subtle.verify compares in constant time.
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, new TextEncoder().encode(login))
  } catch {
    return false
  }
}

export const READY_LABEL = 'goblin'
export const UNTRUSTED_LABEL = 'untrusted'

/**
 * Labels a new ticket gets.
 *
 * - Bugs get the ready label so the runner sees them. An untrusted bug also
 *   gets `untrusted`, which makes the runner hold it (or, if triage later
 *   marks it critical, investigate it read-only).
 * - Feature requests never get the ready label: what to build is a human decision.
 */
export function ticketLabels(type: 'bug' | 'feature' | undefined, trusted: boolean): string[] {
  if (type === 'feature') {
    return trusted ? ['user-feedback', 'enhancement'] : ['user-feedback', 'enhancement', UNTRUSTED_LABEL]
  }
  return trusted
    ? ['user-feedback', 'bug', READY_LABEL]
    : ['user-feedback', 'bug', READY_LABEL, UNTRUSTED_LABEL]
}
