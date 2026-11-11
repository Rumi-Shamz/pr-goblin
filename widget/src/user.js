// Optional reporter identity supplied by the host: { name, login }.
// Plain text only. The Worker re-validates, but stripping here keeps the
// payload honest and the field length bounded before it leaves the page.
export const USER_FIELD_MAX = 120

function cleanField(v) {
  if (typeof v !== 'string') return null
  const s = v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, USER_FIELD_MAX)
  return s.length ? s : null
}

// Returns { name, login } with at least one non-null field, or null.
export function sanitiseUser(user) {
  if (!user || typeof user !== 'object') return null
  const name = cleanField(user.name)
  const login = cleanField(user.login)
  if (!name && !login) return null
  return { name, login }
}
