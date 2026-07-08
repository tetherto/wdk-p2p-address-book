import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import crypto from 'hypercore-crypto'
import enc from 'hypercore-id-encoding'
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

export function sign (message, secretKey) {
  return crypto.sign(toBytes(message), secretKey)
}

export function verifySignature (message, signature, publicKey) {
  return crypto.verify(toBytes(message), toBytes(signature), toBytes(publicKey))
}

function toBytes (input) {
  if (input instanceof Uint8Array) return input
  return b4a.from(input)
}

export function generateId () {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

export function decodeMirrorKey (key) {
  return b4a.isBuffer(key) ? key : enc.decode(enc.normalize(key))
}

export function dedupeKeys (keys) {
  const seen = new Set()
  const result = []
  for (const key of keys) {
    const id = b4a.toString(key, 'hex')
    if (seen.has(id)) continue
    seen.add(id)
    result.push(key)
  }
  return result
}

export function withTimeout (promise, timeout, label) {
  if (!timeout || timeout <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), timeout)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export async function waitFor (fn, label, { timeout = 20000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await delay(interval)
  }
  throw new Error('Timed out waiting for ' + label)
}

export function noop () {}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
