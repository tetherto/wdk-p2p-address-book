import Autobase from 'autobase'
import Hypercore from 'hypercore'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import ReadyResource from 'ready-resource'
import b4a from 'b4a'
import BlindPeering from 'blind-peering'
import enc from 'hypercore-id-encoding'

import { Router, encode } from './spec/hyperdispatch/index.js'
import * as db from './spec/db/index.js'
import {
  deriveSeedKey,
  deriveSeedKeyPair,
  generateId,
  decodeMirrorKey,
  dedupeKeys,
  withTimeout,
  waitFor,
  noop
} from './utils.js'
import {
  assertNonEmptyString,
  normalizeContactName,
  normalizeUsername,
  normalizeAddressInput
} from './address.utils.js'

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

// Embedded seed-derivation labels (prefixed with the per-app namespace).
const ADDRESS_BOOK_SEED_SALT = 'wdk-addressbook-v1'
const ENCRYPTION_INFO = 'autobase-encryption'
const BOOTSTRAP_WRITER_INFO = 'bootstrap-writer'

class AddressBook extends ReadyResource {
  constructor (corestore, opts = {}) {
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

    // Dispatch handlers run inside Autobase's `apply` against the linearized
    // log: `data` is the decoded op payload and `context.view` is the HyperDB
    // view (`context.base` the autobase). They are the authoritative, ordered
    // mutations — API methods only `append` encoded ops; these apply them.

    /** Upsert a contact (last-write-wins on its id). */
    this.router.add('@wdk-addressbook/put-contact', async (data, context) => {
      await context.view.insert('@wdk-addressbook/contacts', data)
    })

    /** Delete a contact and cascade-delete all of its addresses. */
    this.router.add('@wdk-addressbook/del-contact', async (data, context) => {
      await context.view.delete('@wdk-addressbook/contacts', data)
      for await (const addr of context.view.find('@wdk-addressbook/addresses-by-contact', {
        gte: { contactId: data.id },
        lte: { contactId: data.id }
      })) {
        await context.view.delete('@wdk-addressbook/addresses', { id: addr.id })
      }
    })

    /**
     * Upsert an address, enforcing uniqueness deterministically across writers:
     * drop it if the address+network pair (or a duplicate UMA) already exists.
     */
    this.router.add('@wdk-addressbook/put-address', async (data, context) => {
      const existing = await context.view.find('@wdk-addressbook/addresses', {}).toArray()

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

      await context.view.insert('@wdk-addressbook/addresses', data)
    })

    /** Delete a single address by id. */
    this.router.add('@wdk-addressbook/del-address', async (data, context) => {
      await context.view.delete('@wdk-addressbook/addresses', data)
    })

    /** Record a device writer and authorize it on the autobase as an indexer. */
    this.router.add('@wdk-addressbook/add-writer', async (data, context) => {
      await context.view.insert('@wdk-addressbook/writer', data)
      await context.base.addWriter(data.key, { indexer: true })
    })

    /** Remove a device writer record and deauthorize it on the autobase. */
    this.router.add('@wdk-addressbook/remove-writer', async (data, context) => {
      await context.view.delete('@wdk-addressbook/writer', data)
      await context.base.removeWriter(data.key)
    })

    /** Record a blind-peer mirror key (consumed by peering on update). */
    this.router.add('@wdk-addressbook/add-mirror', async (data, context) => {
      await context.view.insert('@wdk-addressbook/mirrors', data)
    })

    /** Remove a blind-peer mirror key. */
    this.router.add('@wdk-addressbook/del-mirror', async (data, context) => {
      await context.view.delete('@wdk-addressbook/mirrors', { key: data.key })
    })

    this._bootOpts = opts
  }

  async _apply (nodes, view, base) {
    for (const node of nodes) {
      await this.router.dispatch(node.value, { view, base })
    }
    await view.flush()
  }

  async _open () {
    if (this.base) throw new Error('Address book is already open')

    const opts = this._bootOpts
    const { encryptionKey, key, wakeup } = opts

    this.base = new Autobase(this.store, key, {
      wakeup,
      encrypt: !!encryptionKey,
      encryptionKey,
      keyPair: opts.keyPair || null,
      optimistic: !!opts.optimistic,
      open (store) {
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

    await this.base.ready()
    if (this.replicate) await this._replicate()
  }

  async _close () {
    // Flush pending autobase work before close, else close() can throw
    // "Cannot close while sessions are open" (it races the post-enroll update).
    if (this.base) {
      try {
        await this.base.update()
      } catch {
        // ignore: flush is best-effort, close must proceed anyway
      }
    }
    if (this.peering) await this.peering.close()
    if (this.swarm) await this.swarm.destroy()
    if (this.base) await this.base.close()

    this.peering = null
    this.swarm = null
    this.base = null
  }

  // Properties

  get writerKey () {
    return this.base.local.key
  }

  get key () {
    return this.base.key
  }

  get discoveryKey () {
    return this.base.discoveryKey
  }

  get encryptionKey () {
    return this.base.encryptionKey
  }

  get writable () {
    return this.base.writable
  }

  static deriveAutobaseKey (keyPair, { version = 1 } = {}) {
    const publicKey = keyPair && keyPair.publicKey ? keyPair.publicKey : keyPair
    if (!publicKey) throw new Error('Bootstrap keyPair (or public key) is required')
    return Hypercore.key({ version, signers: [{ publicKey }] })
  }

  static async fromSeed (seed, corestore, opts = {}) {
    if (!seed) throw new Error('seed is required')
    if (!corestore) throw new Error('corestore is required')
    if (!opts.namespace) throw new Error('namespace is required')

    const { namespace } = opts
    const encryptionKey = deriveSeedKey(seed, {
      salt: ADDRESS_BOOK_SEED_SALT,
      info: namespace + ':' + ENCRYPTION_INFO
    })
    const bootstrapKeyPair = deriveSeedKeyPair(seed, {
      salt: ADDRESS_BOOK_SEED_SALT,
      info: namespace + ':' + BOOTSTRAP_WRITER_INFO
    })
    const key = AddressBook.deriveAutobaseKey(bootstrapKeyPair)

    const store = corestore.namespace(namespace)
    const keyPair = await store.createKeyPair(DEVICE_WRITER_NAME)

    const book = new AddressBook(store, {
      ...opts,
      key,
      keyPair,
      encryptionKey
    })

    try {
      await book.ready()
      if (!book.writable) {
        // Sync any existing book from mirrors before enrolling, so a restoring
        // device joins it instead of forking a fresh genesis.
        if (book.mirrors.length > 0) await book._waitForBootstrap(opts.timeout)
        await book._enrollLocalWriter({
          keyPair: bootstrapKeyPair,
          name: opts.name || null,
          timeout: opts.timeout
        })
      }
    } catch (err) {
      await book.close()
      throw err
    }

    return book
  }

  async _enrollLocalWriter ({ keyPair, name = null, timeout } = {}) {
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

  async _waitForBootstrap (timeout = 20000) {
    try {
      await waitFor(
        async () => {
          await this.base.update()
          return this.base.length > 0 || this.writable
        },
        'address book genesis to sync from mirror',
        { timeout }
      )
    } catch {
      // No genesis synced: treat as a first/offline device and create one.
    }
  }

  static async _authorizeWriter (store, { key, keyPair, encryptionKey, writer }) {
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

  async _waitUntilWritable (timeout = 20000) {
    if (this.writable) return

    let onWritable
    const writable = new Promise((resolve) => {
      onWritable = resolve
      this.base.once('writable', onWritable)
    })

    // Process locally-available state (e.g. an in-process enrollment) first.
    await this.base.update()
    if (this.writable) {
      this.base.off('writable', onWritable)
      return
    }

    try {
      await withTimeout(writable, timeout, 'local writer to become writable')
    } catch (err) {
      this.base.off('writable', onWritable)
      throw err
    }
  }

  // Contact CRUD

  async addContact ({ name, username = null }) {
    if (this.opened === false) await this.ready()
    const now = Date.now()
    const id = generateId()
    const record = {
      id,
      name: normalizeContactName(name),
      username: normalizeUsername(username),
      createdAt: now,
      updatedAt: now
    }
    await this.base.append(encode('@wdk-addressbook/put-contact', record))
    return record
  }

  async editContact (id, updates) {
    if (this.opened === false) await this.ready()
    const existing = await this.base.view.get('@wdk-addressbook/contacts', { id })
    if (!existing) throw new Error('Contact not found: ' + id)
    const record = {
      id: existing.id,
      name: updates.name !== undefined ? normalizeContactName(updates.name) : existing.name,
      username: updates.username !== undefined
        ? normalizeUsername(updates.username)
        : (existing.username ?? null),
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }
    await this.base.append(encode('@wdk-addressbook/put-contact', record))
    return record
  }

  async deleteContact (id) {
    if (this.opened === false) await this.ready()
    await this.base.append(encode('@wdk-addressbook/del-contact', { id }))
  }

  async getContact (id) {
    if (this.opened === false) await this.ready()
    return this.base.view.get('@wdk-addressbook/contacts', { id })
  }

  async listContacts () {
    if (this.opened === false) await this.ready()
    const results = await this.base.view.find('@wdk-addressbook/contacts', {}).toArray()
    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Address CRUD

  async addAddress (contactId, input) {
    if (this.opened === false) await this.ready()
    const normalized = normalizeAddressInput(input)

    const contact = await this.base.view.get('@wdk-addressbook/contacts', {
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
    await this.base.append(encode('@wdk-addressbook/put-address', record))
    return record
  }

  async editAddress (id, updates) {
    if (this.opened === false) await this.ready()
    const existing = await this.base.view.get('@wdk-addressbook/addresses', { id })
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
    await this.base.append(encode('@wdk-addressbook/put-address', record))
    return record
  }

  async deleteAddress (id) {
    if (this.opened === false) await this.ready()
    await this.base.append(encode('@wdk-addressbook/del-address', { id }))
  }

  async listAddresses (contactId) {
    if (this.opened === false) await this.ready()
    if (contactId) {
      return this.base.view.find('@wdk-addressbook/addresses-by-contact', {
        gte: { contactId },
        lte: { contactId }
      }).toArray()
    }
    return this.base.view.find('@wdk-addressbook/addresses', {}).toArray()
  }

  // Search

  async search (query) {
    if (this.opened === false) await this.ready()
    const q = query.toLowerCase()

    const contacts = await this.base.view.find('@wdk-addressbook/contacts', {}).toArray()
    const addresses = await this.base.view.find('@wdk-addressbook/addresses', {}).toArray()

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

  async _validateAddressRecord (record, { excludeId = null } = {}) {
    assertNonEmptyString(record.address, 'Address')
    assertNonEmptyString(record.network, 'Address network')
    assertNonEmptyString(record.type, 'Address type')
    if (!ADDRESS_TYPE_SET.has(record.type)) {
      throw new Error('Unsupported address type: ' + record.type)
    }

    const all = await this.base.view.find('@wdk-addressbook/addresses', {}).toArray()
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

  async addWriter (data) {
    if (typeof data === 'string') data = b4a.from(data, 'hex')
    if (b4a.isBuffer(data)) data = { key: data, name: null }
    await this.base.append(encode('@wdk-addressbook/add-writer', data))
  }

  async removeWriter (key) {
    await this.base.append(
      encode('@wdk-addressbook/remove-writer', {
        key: b4a.isBuffer(key) ? key : b4a.from(key, 'hex')
      })
    )
  }

  listWriters (query) {
    return this.base.view.find('@wdk-addressbook/writer', query || {})
  }

  async getWriter (key) {
    return this.base.view.get('@wdk-addressbook/writer', { key })
  }

  // Mirrors

  async addMirror (key) {
    const keyBuffer = enc.decode(enc.normalize(key))
    await this.base.append(encode('@wdk-addressbook/add-mirror', { key: keyBuffer }))
    await this._updatePeering()
  }

  async listMirrors () {
    const results = await this.base.view.find('@wdk-addressbook/mirrors', {}).toArray()
    return results.map((r) => ({ ...r, key: enc.encode(r.key) }))
  }

  async removeMirror (key) {
    const keyBuffer = enc.decode(enc.normalize(key))
    await this.base.append(encode('@wdk-addressbook/del-mirror', { key: keyBuffer }))
    await this._updatePeering()
  }

  // Replication

  async _replicate () {
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

  async _updatePeering () {
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

  _updatePeeringBackground () {
    if (!this.swarm || this._updatingPeering) return
    this._updatingPeering = this._updatePeering()
      .catch(noop)
      .finally(() => {
        this._updatingPeering = null
      })
  }

  // Lifecycle

  async suspend () {
    if (this.swarm) {
      await this.swarm.suspend()
      await this.store.suspend()
    }
  }

  async resume () {
    if (this.swarm) {
      await this.store.resume()
      await this.swarm.resume()
    }
  }
}

export { AddressBook, ADDRESS_TYPES }
export default AddressBook
