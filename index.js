import Autobase from 'autobase'
import Hypercore from 'hypercore'
import HyperDB from 'hyperdb'
import Hyperswarm from 'hyperswarm'
import ReadyResource from 'ready-resource'
import b4a from 'b4a'
import BlindPeering from 'blind-peering'
import Corestore from 'corestore'
import enc from 'hypercore-id-encoding'
import { sha256 } from '@noble/hashes/sha2.js'

import { Router, encode } from './spec/hyperdispatch/index.js'
import * as db from './spec/db/index.js'
import { deriveSeedKey, deriveSeedKeyPair } from '@tetherto/wdk-utils'
import {
  sign,
  verifySignature,
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

    /**
     * Record a device writer and authorize it as an indexer. An optimistic op (from a
     * not-yet-authorized core) must self-admit only its own key and carry `proof`, a
     * signature over that key from the seed-derived bootstrap secret; non-optimistic adds are trusted.
     */
    this.router.add('@wdk-addressbook/add-writer', async (data, context) => {
      if (context.optimistic) {
        if (!b4a.equals(data.key, context.writerKey)) return
        if (!this._bootstrapKeyPair || !data.proof) return
        if (!verifySignature(data.key, data.proof, this._bootstrapKeyPair.publicKey)) return
      }
      await context.view.insert('@wdk-addressbook/writer', { key: data.key, name: data.name })
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
      await this.router.dispatch(node.value, {
        view,
        base,
        optimistic: node.optimistic,
        writerKey: node.from ? node.from.key : null
      })
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
      optimistic: true, // required: enrollment self-admits via optimistic append
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
    // Cold reopen: ready() can lag a tick behind our own durable optimistic
    // add-writer node, so one update() settles `writable` before callers see it.
    await this.base.update()
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

    // Construct is read-only; enroll explicitly via create() for a new book or addMirror()
    // to sync and join an existing one. A reopened book with a persisted writer is writable.
    book._bootstrapKeyPair = bootstrapKeyPair
    book._enrollName = opts.name || null
    book._enrollTimeout = opts.timeout

    try {
      await book.ready()
    } catch (err) {
      await book.close()
      throw err
    }

    return book
  }

  /**
   * Worklet-module factory for the bundler. Isolates each user under a seed-derived
   * subdir of config.storagePath so two seeds never share a corestore on one device.
   */
  static async createWorkletModule ({ seed, config }) {
    const { storagePath, ...opts } = config || {}
    // Per-user isolation: a one-way subdir keyed on the seed.
    const scope = b4a.toString(
      deriveSeedKey(seed, { salt: ADDRESS_BOOK_SEED_SALT, info: (opts.namespace ?? 'default') + ':storage-scope' }),
      'hex'
    ).slice(0, 32)
    const store = new Corestore(storagePath.replace(/\/+$/, '') + '/' + scope)
    let book
    try {
      book = await AddressBook.fromSeed(seed, store, opts)
    } catch (err) {
      await store.close().catch(() => {})
      throw err
    }
    const close = book.close.bind(book)
    book.close = async () => { await close(); await store.close() }
    return book
  }

  /**
   * Rank a mirror pool for this book by HRW and return the top `n`. Deterministic and
   * recomputable anywhere from the autobase key, with minimal churn if the pool changes.
   *
   * @param {Uint8Array | string} autobaseKey - book's autobase key, hex or buffer
   * @param {Array<string | Uint8Array>} pool - candidate mirror keys
   * @param {number} [n=1] - how many to return, highest-ranked first
   * @returns {Array<string | Uint8Array>} up to `n` pool entries, ranked
   */
  static selectMirrors (autobaseKey, pool, n = 1) {
    if (!pool || pool.length === 0 || n <= 0) return []
    const keyBuf = b4a.isBuffer(autobaseKey) ? autobaseKey : b4a.from(autobaseKey, 'hex')
    const scored = pool.map((mirror) => {
      const mk = decodeMirrorKey(mirror) // raw key bytes — must match what the BE hashes
      return { mirror, mk, score: b4a.from(sha256(b4a.concat([keyBuf, mk]))) }
    })
    // Score desc; tie -> larger key, so the order is input-order-independent.
    scored.sort((a, b) => b4a.compare(b.score, a.score) || b4a.compare(b.mk, a.mk))
    return scored.slice(0, n).map((s) => s.mirror)
  }

  /**
   * Public identity for the host after construct: the public autobaseKey and whether this
   * device can write yet. The encryption key is never exposed.
   *
   * @returns {Promise<{ autobaseKey: string, writable: boolean }>}
   */
  async getInfo () {
    if (this.opened === false) await this.ready()
    return {
      autobaseKey: b4a.toString(this.key, 'hex'),
      writable: this.writable
    }
  }

  /** Enroll via an optimistic self-append; adoption happens once add-writer applies it. */
  async _enrollLocalWriter ({ name = null, timeout } = {}) {
    if (this.opened === false) await this.ready()

    const proof = sign(this.writerKey, this._bootstrapKeyPair.secretKey) // proves we hold the seed
    const writer = { key: this.writerKey, name, proof }
    await this.base.append(encode('@wdk-addressbook/add-writer', writer), { optimistic: true })
    await this._waitUntilWritable(timeout)
    return writer
  }

  /**
   * Enroll this device's writer if not already writable. With bootstrap, sync an existing
   * book from mirrors first and throw if it can't — join-only, never fork. Without
   * bootstrap, enroll a fresh book. Used by addMirror() and create() respectively.
   */
  async _ensureEnrolled ({ bootstrap = false } = {}) {
    if (this.writable) return
    if (!this._bootstrapKeyPair) throw new Error('address book was not constructed from a seed; cannot enroll')
    if (bootstrap) {
      const synced = this.mirrors.length > 0 && await this._waitForBootstrap(this._enrollTimeout)
      if (!synced) {
        throw new Error('could not sync the existing address book from its mirror(s); retry addMirror() once a mirror is reachable')
      }
    }
    await this._enrollLocalWriter({ name: this._enrollName, timeout: this._enrollTimeout })
  }

  /**
   * Enroll as a brand-new book, without waiting to sync. Use only when no existing book
   * could exist to restore; otherwise use addMirror() to sync and join.
   */
  async create () {
    await this._ensureEnrolled({ bootstrap: false })
  }

  // Returns true if an existing book synced from a mirror, false on timeout.
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
      return true
    } catch {
      return false
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

  /**
   * Register + peer with blind-peer mirrors. `addMirror(key)` adds one; `addMirror(pool, n)`
   * ranks the pool by HRW and adds the top `n`, so the host can forward the BE pool without
   * the autobase key. A deferred book syncs an existing book first, then enrolls into it.
   *
   * @param {string | Uint8Array | Array<string | Uint8Array>} key - a mirror key or a pool
   * @param {number} [n=1] - when a pool is given, how many to select
   * @returns {Promise<Array<string | Uint8Array>>} the mirror key(s) selected, as given —
   *   a pass-through, like `selectMirrors`. Always an array, one entry for the single-key
   *   form. Returned even when already registered from a prior call.
   */
  async addMirror (key, n = 1) {
    const selected = Array.isArray(key) ? AddressBook.selectMirrors(this.key, key, n) : [key]
    if (selected.length === 0) return []
    const keyBuffers = selected.map((k) => enc.decode(k))

    for (const keyBuffer of keyBuffers) {
      if (!this.mirrors.some((m) => b4a.equals(m, keyBuffer))) this.mirrors.push(keyBuffer)
    }
    await this._updatePeering()
    await this._ensureEnrolled({ bootstrap: true })
    for (const keyBuffer of keyBuffers) {
      await this.base.append(encode('@wdk-addressbook/add-mirror', { key: keyBuffer }))
    }
    await this._updatePeering()
    return selected
  }

  /**
   * @returns {Promise<Array<{ key: Uint8Array }>>} registered mirrors, key as raw bytes —
   *   same pass-through style as `selectMirrors`. The worklet bridge auto-normalizes
   *   `Uint8Array` to hex.
   */
  async listMirrors () {
    return this.base.view.find('@wdk-addressbook/mirrors', {}).toArray()
  }

  async removeMirror (key) {
    const keyBuffer = enc.decode(key)
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
    this.swarm.flush().then(() => this._updatePeering()).catch(noop)
  }

  async _updatePeering () {
    if (!this.swarm) return
    const mirrorList = await this.listMirrors()
    const mirrors = dedupeKeys([
      ...this.mirrors,
      ...mirrorList.map((item) => item.key)
    ])
    if (this.peering) {
      this.peering.setKeys(mirrors)
    } else if (mirrors.length > 0) {
      this.peering = new BlindPeering(this.swarm.dht, this.store, {
        wakeup: this.base.wakeupProtocol,
        keys: mirrors,
        relayThrough: this.relayThrough
      })
    }
    // priority 2: restore data is written once, rarely updated — keep it last in line for blind-peer GC
    if (mirrors.length > 0) this.peering.addAutobaseBackground(this.base, { priority: 2 })
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
    if (this.peering) await this.peering.suspend()
    if (this.swarm) await this.swarm.suspend()
    await this.store.suspend()
  }

  async resume () {
    await this.store.resume()
    if (this.swarm) await this.swarm.resume()
    if (this.peering) await this.peering.resume()
  }
}

export { AddressBook, ADDRESS_TYPES }
export default AddressBook
