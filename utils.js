import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

export function deriveSeedKey (seed, { salt, info, length = 32 } = {}) {
  if (salt === undefined) throw new Error('salt is required')
  if (info === undefined) throw new Error('info is required')
  return b4a.from(hkdf(sha256, toBytes(seed), toBytes(salt), toBytes(info), length))
}

export function deriveSeedKeyPair (seed, opts) {
  return crypto.keyPair(deriveSeedKey(seed, { ...opts, length: 32 }))
}

export function signWithDerivedKey (message, seed, opts) {
  const keyPair = deriveSeedKeyPair(seed, opts)
  return crypto.sign(toBytes(message), keyPair.secretKey)
}

export function verifySignature (message, signature, publicKey) {
  return crypto.verify(toBytes(message), toBytes(signature), toBytes(publicKey))
}

function toBytes (input) {
  if (input instanceof Uint8Array) return input
  return b4a.from(input)
}
