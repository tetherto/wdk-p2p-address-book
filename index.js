import Autobase from 'autobase'
import Hypercore from 'hypercore'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import ReadyResource from 'ready-resource'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import BlindPeering from 'blind-peering'
import enc from 'hypercore-id-encoding'

import { Router, encode } from './spec/hyperdispatch/index.js'
import * as db from './spec/db/index.js'

const ADDRESS_TYPES = Object.freeze({
  BITCOIN: 'bitcoin',
  EVM: 'evm',
  TRON: 'tron',
  UMA: 'uma',
  LIGHTNING_ADDRESS: 'lightning-address',
  LNURL: 'lnurl',
  SPARK: 'spark'
})
const ADDRESS_TYPE_SET = new Set(Object.values(ADDRESS_TYPES))

// Stable per-store device-writer key name (reopen-safe).
const DEVICE_WRITER_NAME = 'addressbook-writer'

// Placeholder pending product guidance.
const MAX_CONTACT_NAME_LENGTH = 256

class AddressBook extends ReadyResource {
  constructor(corestore, opts = {}) {
    super()
    this.router = new Router()
    this.store = corestore
    this.swarm = opts.swarm || null
    this.base = null
    this.bootstrap = opts.bootstrap || null
    this.peering = null
    this.replicate = opts.replicate !== false
    this.relayThrough = opts.relayThrough || null
    this.mirrors = (opts.mirrors || []).map(decodeMirrorKey)
    this._updatingPeering = null

    this.router.add('@addressbook/put-contact', async (data, context) => {
      await context.view.insert('@addressbook/contacts', data)
    })

    this.router.add('@addressbook/del-contact', async (data, context) => {
      await context.view.delete('@addressbook/contacts', data)
      const addresses = await context.view
        .find('@addressbook/addresses', { contactId: data.id })
        .toArray()
      for (const addr of addresses) {
        await context.view.delete('@addressbook/addresses', { id: addr.id })
      }
    })

    this.router.add('@addressbook/put-address', async (data, context) => {
      const existing = await context.view.find('@addressbook/addresses', {}).toArray()

      const networkTaken = existing.some(
        (a) => a.id !== data.id && a.address === data.address && a.network === data.network
      )
      if (networkTaken) return

      if (data.type === ADDRESS_TYPES.UMA) {
        const umaTaken = existing.some(
          (a) => a.id !== data.id && a.type === ADDRESS_TYPES.UMA && a.address === data.address
        )
        if (umaTaken) return
      }

      await context.view.insert('@addressbook/addresses', data)
    })

    this.router.add('@addressbook/del-address', async (data, context) => {
      await context.view.delete('@addressbook/addresses', data)
    })

    this.router.add('@addressbook/add-writer', async (data, context) => {
      await context.view.insert('@addressbook/writer', data)
      await context.base.addWriter(data.key, { indexer: true })
    })

    this.router.add('@addressbook/remove-writer', async (data, context) => {
      await context.view.delete('@addressbook/writer', data)
      await context.base.removeWriter(data.key)
    })

    this.router.add('@addressbook/add-mirror', async (data, context) => {
      await context.view.insert('@addressbook/mirrors', data)
    })

    this.router.add('@addressbook/del-mirror', async (data, context) => {
      await context.view.delete('@addressbook/mirrors', { key: data.key })
    })

    this._boot(opts)
    this.ready().catch(noop)
  }

  _boot(opts = {}) {
    const { encryptionKey, key, wakeup } = opts

    this.base = new Autobase(this.store, key, {
      wakeup,
      encrypt: !!encryptionKey,
      encryptionKey,
      keyPair: opts.keyPair || null,
      optimistic: !!opts.optimistic,
      open(store) {
        return HyperDB.bee(store.get('view'), db, {
          extension: false,
          autoUpdate: true
        })
      },
      apply: this._apply.bind(this)
    })

    this.base.on('update', () => {
      if (!this.base._interrupting) {
        this.emit('update')
        this._updatePeeringBackground()
      }
    })
  }

  async _apply(nodes, view, base) {
    for (const node of nodes) {
      await this.router.dispatch(node.value, { view, base })
    }
    await view.flush()
  }

  async _open() {
    await this.base.ready()
    if (this.replicate) await this._replicate()
  }

  async _close() {
    if (this.peering) await this.peering.close()
    if (this.swarm) await this.swarm.destroy()
    await this.base.close()
  }

  // Properties

  get writerKey() {
    return this.base.local.key
  }

  get key() {
    return this.base.key
  }

  get discoveryKey() {
    return this.base.discoveryKey
  }

  get encryptionKey() {
    return this.base.encryptionKey
  }

  get writable() {
    return this.base.writable
  }

  static deriveAutobaseKey(keyPair, { version = 1 } = {}) {
    const publicKey = keyPair && keyPair.publicKey ? keyPair.publicKey : keyPair
    if (!publicKey) throw new Error('Bootstrap keyPair (or public key) is required')
    return Hypercore.key({ version, signers: [{ publicKey }] })
  }

  static async create(store, opts = {}) {
    const { keyPair: bootstrapKeyPair, encryptionKey } = opts
    if (!bootstrapKeyPair) {
      throw new Error('Bootstrap keyPair is required to create an address book')
    }

    const key = opts.key || AddressBook.deriveAutobaseKey(bootstrapKeyPair)
    const keyPair = await store.createKeyPair(DEVICE_WRITER_NAME)
    const book = new AddressBook(store, { ...opts, key, keyPair })

    try {
      await book.ready()
      await AddressBook._authorizeWriter(store, {
        key,
        keyPair: bootstrapKeyPair,
        encryptionKey,
        writer: { key: book.writerKey, name: opts.name || null }
      })
      await book._waitUntilWritable(opts.timeout)
    } catch (err) {
      await book.close()
      throw err
    }

    return book
  }

  static async open(store, opts = {}) {
    if (!opts.key) throw new Error('key is required to open an existing address book')
    const keyPair = opts.keyPair || (await store.createKeyPair(DEVICE_WRITER_NAME))
    const book = new AddressBook(store, { ...opts, keyPair })
    await book.ready()
    return book
  }

  async enrollLocalWriter({ keyPair, name = null, timeout } = {}) {
    if (this.opened === false) await this.ready()
    if (!keyPair) throw new Error('Bootstrap keyPair is required')

    const writer = { key: this.writerKey, name }
    await AddressBook._authorizeWriter(this.store, {
      key: this.key,
      keyPair,
      encryptionKey: this.encryptionKey,
      writer
    })
    await this._waitUntilWritable(timeout)
    return writer
  }

  static async _authorizeWriter(store, { key, keyPair, encryptionKey, writer }) {
    const authorityStore = store.namespace('writer-enrollment-' + generateId())
    const authority = new AddressBook(authorityStore, {
      key,
      keyPair,
      encryptionKey,
      replicate: false
    })

    try {
      await authority.ready()
      await authority.addWriter(writer)
    } finally {
      await authority.close()
    }
  }

  async _waitUntilWritable(timeout = 20000) {
    await waitFor(
      async () => {
        await this.base.update()
        return this.writable
      },
      'local writer to become writable',
      { timeout }
    )
  }

  // Contact CRUD

  async addContact({ name }) {
    if (this.opened === false) await this.ready()
    const now = Date.now()
    const id = generateId()
    const record = { id, name: normalizeContactName(name), createdAt: now, updatedAt: now }
    await this.base.append(encode('@addressbook/put-contact', record))
    return record
  }

  async editContact(id, updates) {
    if (this.opened === false) await this.ready()
    const existing = await this.base.view.get('@addressbook/contacts', { id })
    if (!existing) throw new Error('Contact not found: ' + id)
    const record = {
      id: existing.id,
      name: updates.name !== undefined ? normalizeContactName(updates.name) : existing.name,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }
    await this.base.append(encode('@addressbook/put-contact', record))
    return record
  }

  async deleteContact(id) {
    if (this.opened === false) await this.ready()
    await this.base.append(encode('@addressbook/del-contact', { id }))
  }

  async getContact(id) {
    if (this.opened === false) await this.ready()
    return this.base.view.get('@addressbook/contacts', { id })
  }

  async listContacts() {
    if (this.opened === false) await this.ready()
    const results = await this.base.view.find('@addressbook/contacts', {}).toArray()
    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Address CRUD

  async addAddress(contactId, input) {
    if (this.opened === false) await this.ready()
    const normalized = normalizeAddressInput(input)

    const contact = await this.base.view.get('@addressbook/contacts', {
      id: contactId
    })
    if (!contact) throw new Error('Contact not found: ' + contactId)

    const now = Date.now()
    const id = generateId()
    const record = {
      id,
      contactId,
      address: normalized.address,
      type: normalized.type,
      network: normalized.network,
      label: normalized.label,
      createdAt: now,
      updatedAt: now
    }
    await this._validateAddressRecord(record)
    await this.base.append(encode('@addressbook/put-address', record))
    return record
  }

  async editAddress(id, updates) {
    if (this.opened === false) await this.ready()
    const existing = await this.base.view.get('@addressbook/addresses', { id })
    if (!existing) throw new Error('Address not found: ' + id)
    const normalized = normalizeAddressInput(updates, { partial: true })

    const record = {
      id: existing.id,
      contactId: existing.contactId,
      address: normalized.address !== undefined ? normalized.address : existing.address,
      type: normalized.type !== undefined ? normalized.type : existing.type,
      network: normalized.network !== undefined ? normalized.network : existing.network,
      label: normalized.label !== undefined ? normalized.label : existing.label,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }
    await this._validateAddressRecord(record, { excludeId: id })
    await this.base.append(encode('@addressbook/put-address', record))
    return record
  }

  async deleteAddress(id) {
    if (this.opened === false) await this.ready()
    await this.base.append(encode('@addressbook/del-address', { id }))
  }

  async listAddresses(contactId) {
    if (this.opened === false) await this.ready()
    if (contactId) {
      return this.base.view.find('@addressbook/addresses', { contactId }).toArray()
    }
    return this.base.view.find('@addressbook/addresses', {}).toArray()
  }

  // Search

  async search(query) {
    if (this.opened === false) await this.ready()
    const q = query.toLowerCase()

    const contacts = await this.base.view.find('@addressbook/contacts', {}).toArray()
    const addresses = await this.base.view.find('@addressbook/addresses', {}).toArray()

    const matchedContactIds = new Set()

    for (const contact of contacts) {
      if (contact.name.toLowerCase().includes(q)) {
        matchedContactIds.add(contact.id)
      }
    }

    for (const addr of addresses) {
      if (
        addr.address.toLowerCase().includes(q) ||
        (addr.label && addr.label.toLowerCase().includes(q))
      ) {
        matchedContactIds.add(addr.contactId)
      }
    }

    return contacts
      .filter((c) => matchedContactIds.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async _validateAddressRecord(record, { excludeId = null } = {}) {
    assertNonEmptyString(record.address, 'Address')
    assertNonEmptyString(record.network, 'Address network')
    assertNonEmptyString(record.type, 'Address type')
    if (!ADDRESS_TYPE_SET.has(record.type)) {
      throw new Error('Unsupported address type: ' + record.type)
    }

    const all = await this.base.view.find('@addressbook/addresses', {}).toArray()
    const addresses = excludeId === null ? all : all.filter((a) => a.id !== excludeId)

    if (record.type === ADDRESS_TYPES.UMA) {
      const existing = addresses.find(
        (a) => a.type === ADDRESS_TYPES.UMA && a.address === record.address
      )
      if (existing) throw new Error('UMA already exists in address book: ' + record.address)
    }

    const duplicate = addresses.find(
      (a) => a.address === record.address && a.network === record.network
    )
    if (duplicate) {
      throw new Error(`Address already saved for network ${record.network}: ${record.address}`)
    }
  }

  // Writers

  async addWriter(data) {
    if (typeof data === 'string') data = b4a.from(data, 'hex')
    if (b4a.isBuffer(data)) data = { key: data, name: null }
    await this.base.append(encode('@addressbook/add-writer', data))
  }

  async removeWriter(key) {
    await this.base.append(
      encode('@addressbook/remove-writer', {
        key: b4a.isBuffer(key) ? key : b4a.from(key, 'hex')
      })
    )
  }

  listWriters(query) {
    return this.base.view.find('@addressbook/writer', query || {})
  }

  async getWriter(key) {
    return this.base.view.get('@addressbook/writer', { key })
  }

  // Mirrors

  async addMirror(key) {
    const keyBuffer = enc.decode(enc.normalize(key))
    await this.base.append(encode('@addressbook/add-mirror', { key: keyBuffer }))
    await this._updatePeering()
  }

  async listMirrors() {
    const results = await this.base.view.find('@addressbook/mirrors', {}).toArray()
    return results.map((r) => ({ ...r, key: enc.encode(r.key) }))
  }

  async removeMirror(key) {
    const keyBuffer = enc.decode(enc.normalize(key))
    await this.base.append(encode('@addressbook/del-mirror', { key: keyBuffer }))
    await this._updatePeering()
  }

  // Replication

  async _replicate() {
    await this.base.ready()
    if (this.swarm === null) {
      this.swarm = new Hyperswarm({
        keyPair: await this.store.createKeyPair('hyperswarm'),
        bootstrap: this.bootstrap,
        relayThrough: this.relayThrough
      })
      this.swarm.on('connection', (connection) => {
        this.base.replicate(connection)
      })
    }

    this.swarm.join(this.base.discoveryKey)
    await this.swarm.flush()
    await this._updatePeering()
  }

  async _updatePeering() {
    if (!this.swarm) return
    const mirrorList = await this.listMirrors()
    const mirrors = dedupeKeys([
      ...this.mirrors,
      ...mirrorList.map((item) => enc.decode(enc.normalize(item.key)))
    ])
    if (this.peering) {
      this.peering.setKeys(mirrors)
    } else if (mirrors.length > 0) {
      this.peering = new BlindPeering(this.swarm, this.store, {
        wakeup: this.base.wakeupProtocol,
        autobaseMirrors: mirrors
      })
    }
    if (mirrors.length > 0) this.peering.addAutobaseBackground(this.base, undefined, { all: true })
  }

  _updatePeeringBackground() {
    if (!this.swarm || this._updatingPeering) return
    this._updatingPeering = this._updatePeering()
      .catch(noop)
      .finally(() => {
        this._updatingPeering = null
      })
  }

  // Lifecycle

  async suspend() {
    if (this.swarm) {
      await this.swarm.suspend()
      await this.store.suspend()
    }
  }

  async resume() {
    if (this.swarm) {
      await this.store.resume()
      await this.swarm.resume()
    }
  }
}

function generateId() {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' is required')
  }
}

function normalizeContactName(name) {
  if (typeof name !== 'string') throw new Error('Contact name is required')
  const trimmed = name.trim()
  if (trimmed.length === 0) throw new Error('Contact name is required')
  if (trimmed.length > MAX_CONTACT_NAME_LENGTH) {
    throw new Error('Contact name must be at most ' + MAX_CONTACT_NAME_LENGTH + ' characters')
  }
  return trimmed
}

function normalizeAddressInput(input, { partial = false } = {}) {
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

function normalizeRequiredString(target, input, field, name, { partial, lower = false } = {}) {
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

async function waitFor(fn, label, { timeout = 20000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await delay(interval)
  }
  throw new Error('Timed out waiting for ' + label)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodeMirrorKey(key) {
  return b4a.isBuffer(key) ? key : enc.decode(enc.normalize(key))
}

function dedupeKeys(keys) {
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

function noop() {}

export { AddressBook, ADDRESS_TYPES }
export default AddressBook
