const MAX_CONTACT_NAME_LENGTH = 256

export function assertNonEmptyString (value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' is required')
  }
}

export function normalizeUsername (username) {
  if (username === null || username === undefined) return null
  if (typeof username !== 'string') throw new Error('Contact username must be a string')
  const trimmed = username.trim()
  return trimmed.length === 0 ? null : trimmed
}

export function normalizeContactName (name) {
  if (typeof name !== 'string') throw new Error('Contact name is required')
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('Contact name is required')
  if (trimmed.length > MAX_CONTACT_NAME_LENGTH) {
    throw new Error('Contact name must be at most ' + MAX_CONTACT_NAME_LENGTH + ' characters')
  }
  return trimmed
}

export function normalizeAddressInput (input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Address input is required')
  if ('networks' in input) throw new Error('Use network instead of networks')

  const result = {}
  normalizeRequiredString(result, input, 'address', 'Address', { partial })
  normalizeRequiredString(result, input, 'type', 'Address type', { partial })
  normalizeRequiredString(result, input, 'network', 'Address network', {
    partial,
    lower: true
  })

  if ('label' in input) {
    if (input.label === null || input.label === undefined) {
      result.label = null
    } else if (typeof input.label === 'string') {
      const label = input.label.trim()
      result.label = label.length === 0 ? null : label
    } else {
      throw new Error('Address label must be a string')
    }
  } else if (!partial) {
    result.label = null
  }

  return result
}

function normalizeRequiredString (target, input, field, name, { partial, lower = false } = {}) {
  if (!(field in input)) {
    if (partial) return
    throw new Error(name + ' is required')
  }
  const value = input[field]
  if (typeof value !== 'string') throw new Error(name + ' is required')
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(name + ' is required')
  target[field] = lower ? trimmed.toLowerCase() : trimmed
}
