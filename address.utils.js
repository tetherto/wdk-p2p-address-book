const MAX_CONTACT_NAME_LENGTH = 256
const MAX_ADDRESS_LENGTH = 1024
const MAX_ADDRESS_NETWORK_LENGTH = 64
const MAX_ADDRESS_LABEL_LENGTH = 256

export function assertNonEmptyString (value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' is required')
  }
}

export function normalizeUsername (username) {
  if (username === null || username === undefined) return null
  if (typeof username !== 'string') throw new Error('Contact username must be a string')
  const trimmed = username.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_CONTACT_NAME_LENGTH) {
    throw new Error('Contact username must be at most ' + MAX_CONTACT_NAME_LENGTH + ' characters')
  }
  return trimmed
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
  normalizeRequiredString(result, input, 'address', 'Address', {
    partial,
    maxLength: MAX_ADDRESS_LENGTH
  })
  normalizeRequiredString(result, input, 'type', 'Address type', { partial })
  normalizeRequiredString(result, input, 'network', 'Address network', {
    partial,
    lower: true,
    maxLength: MAX_ADDRESS_NETWORK_LENGTH
  })

  if ('label' in input) {
    if (input.label === null || input.label === undefined) {
      result.label = null
    } else if (typeof input.label === 'string') {
      const label = input.label.trim()
      if (label.length > MAX_ADDRESS_LABEL_LENGTH) {
        throw new Error('Address label must be at most ' + MAX_ADDRESS_LABEL_LENGTH + ' characters')
      }
      result.label = label.length === 0 ? null : label
    } else {
      throw new Error('Address label must be a string')
    }
  } else if (!partial) {
    result.label = null
  }

  return result
}

function normalizeRequiredString (target, input, field, name, { partial, lower = false, maxLength = Infinity } = {}) {
  if (!(field in input)) {
    if (partial) return
    throw new Error(name + ' is required')
  }
  const value = input[field]
  if (typeof value !== 'string') throw new Error(name + ' is required')
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(name + ' is required')
  const normalized = lower ? trimmed.toLowerCase() : trimmed
  if (normalized.length > maxLength) {
    throw new Error(name + ' must be at most ' + maxLength + ' characters')
  }
  target[field] = normalized
}
