// Optional reporter identity supplied by the host: { name, login }.
// Plain text only. The Worker re-validates, but stripping here keeps the
// payload honest and the field length bounded before it leaves the page.
export const USER_FIELD_MAX = 120

function cleanField(v) {
  if (typeof v !== 'string') return null
  const s = v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, USER_FIELD_MAX)
  return s.length ? s : null
}

// Proof that the host's backend vouches for this login: a hex HMAC, see
// intake/src/trust.ts. Anything that is not plain hex is dropped.
function cleanProof(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^[0-9a-fA-F]{2,200}$/.test(s) ? s : null
}

// Returns { name, login } with at least one non-null field, or null.
// `proof` is included only when the host supplied a well-formed one.
export function sanitiseUser(user) {
  if (!user || typeof user !== 'object') return null
  const name = cleanField(user.name)
  const login = cleanField(user.login)
  if (!name && !login) return null
  const proof = login ? cleanProof(user.proof) : null
  return proof ? { name, login, proof } : { name, login }
}
