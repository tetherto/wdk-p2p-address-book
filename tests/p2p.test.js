import test from 'brittle'
import Corestore from 'corestore'
import createTestnet from 'hyperdht/testnet.js'
import BlindPeer from 'blind-peer'
import b4a from 'b4a'
import tmp from 'test-tmp'

import AddressBook, { ADDRESS_TYPES } from '../index.js'
import { deriveSeedKeyPair } from '../utils.js'

const TEST_SEED = b4a.alloc(64, 0xcd)
const TEST_NAMESPACE = 'test'
const ADDRESS_BOOK_SEED_SALT = 'wdk-addressbook-v1'
const ADDRESS_BOOK_BOOTSTRAP_WRITER_INFO = 'bootstrap-writer'

test('p2p restore reads from blind peer when first device is offline', async function (t) {
  const testnet = await createTestnet(3, t)

  const mirror = new BlindPeer(await tmp(t), {
    bootstrap: testnet.bootstrap,
    announcingInterval: 50,
    replicationLagThreshold: 0
  })
  t.teardown(() => closeIfOpen(mirror))
  await mirror.ready()
  await mirror.listen()

  // Device A: first device. Construct is read-only; create() establishes the genesis.
  const deviceA = await createDevice(t, TEST_SEED, {
    bootstrap: testnet.bootstrap,
    name: 'Device A'
  })
  await deviceA.create()
  t.absent(
    b4a.equals(deviceA.writerKey, deriveBootstrapKeyPair(TEST_SEED).publicKey),
    'A writes as a device writer'
  )

  await deviceA.addMirror(mirror.publicKey)
  const alice = await deviceA.addContact({ name: 'Alice' })
  await deviceA.addAddress(alice.id, {
    address: '0xalice',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum'
  })
  await deviceA.base.update()
  await deviceA._updatePeering()
  await waitFor(() => mirror.stats.coresAdded > 0, 'blind peer to accept mirrored cores')
  // B rebuilds its view from writer oplogs, so only writer cores must reach the mirror.
  await waitFor(async () => {
    const lengths = await mirroredCoreLengths(mirror, getWriterCores(deviceA.base))
    return lengths.every((entry) => entry.mirrorLength >= entry.sourceLength)
  }, 'blind peer to mirror device A writer cores')
  await closeIfOpen(deviceA)

  // Device B: same seed. Construct read-only, then addMirror syncs from the blind peer
  // and enrolls this device's writer (joins A's book).
  const deviceB = await createDevice(t, TEST_SEED, {
    bootstrap: testnet.bootstrap,
    name: 'Device B'
  })
  await deviceB.addMirror(mirror.publicKey)

  t.ok(deviceB.writable, 'restored device enrolled its writer')

  const restored = await waitFor(async () => {
    await deviceB.base.update()
    return deviceB.getContact(alice.id)
  }, 'second device to restore contact through blind peer')

  t.is(restored.name, 'Alice')

  const restoredAddresses = await waitFor(async () => {
    await deviceB.base.update()
    const addresses = await deviceB.listAddresses(alice.id)
    return addresses.length === 1 ? addresses : null
  }, 'second device to restore address through blind peer')

  t.is(restoredAddresses[0].network, 'ethereum')

  await deviceB.editContact(alice.id, { name: 'Alice Updated' })
  const updatedAlice = await deviceB.getContact(alice.id)
  t.is(updatedAlice.name, 'Alice Updated')

  const bob = await deviceB.addContact({ name: 'Bob' })
  t.is(bob.name, 'Bob')
})

test('one blind peer serves multiple users (multi-tenant, isolated)', async function (t) {
  const testnet = await createTestnet(3, t)

  const mirror = new BlindPeer(await tmp(t), {
    bootstrap: testnet.bootstrap,
    announcingInterval: 50,
    replicationLagThreshold: 0
  })
  t.teardown(() => closeIfOpen(mirror))
  await mirror.ready()
  await mirror.listen()

  const user1Seed = b4a.alloc(64, 0x01)
  const user2Seed = b4a.alloc(64, 0x02)
  t.absent(
    b4a.equals(
      AddressBook.deriveAutobaseKey(deriveBootstrapKeyPair(user1Seed)),
      AddressBook.deriveAutobaseKey(deriveBootstrapKeyPair(user2Seed))
    ),
    'different users derive different autobase keys'
  )

  // Seed a user's book on a device and push it to the single shared mirror, then go offline.
  async function seedUser (seed, contactName) {
    const deviceA = await createDevice(t, seed, { bootstrap: testnet.bootstrap })
    await deviceA.create()
    await deviceA.addMirror(mirror.publicKey)
    const contact = await deviceA.addContact({ name: contactName })
    await deviceA.base.update()
    await deviceA._updatePeering()
    await waitFor(
      async () => {
        const lengths = await mirroredCoreLengths(mirror, getWriterCores(deviceA.base))
        return lengths.every((entry) => entry.mirrorLength >= entry.sourceLength)
      },
      'mirror to hold ' + contactName + ' writer cores'
    )
    await closeIfOpen(deviceA)
    return { contact }
  }

  const u1 = await seedUser(user1Seed, 'Alice')
  const u2 = await seedUser(user2Seed, 'Zoe')

  // Both users restore from the SAME blind peer key.
  const restore1 = await createDevice(t, user1Seed, {
    bootstrap: testnet.bootstrap,
    mirrors: [mirror.publicKey]
  })
  const restore2 = await createDevice(t, user2Seed, {
    bootstrap: testnet.bootstrap,
    mirrors: [mirror.publicKey]
  })

  const r1 = await waitFor(async () => {
    await restore1.base.update()
    return restore1.getContact(u1.contact.id)
  }, 'user 1 to restore from the shared mirror')
  const r2 = await waitFor(async () => {
    await restore2.base.update()
    return restore2.getContact(u2.contact.id)
  }, 'user 2 to restore from the shared mirror')

  t.is(r1.name, 'Alice', 'user 1 restored their own contact from the shared blind peer')
  t.is(r2.name, 'Zoe', 'user 2 restored their own contact from the shared blind peer')

  // Isolation: neither user can see the other's data.
  t.is((await restore1.listContacts()).length, 1, 'user 1 sees only their own contact')
  t.is((await restore2.listContacts()).length, 1, 'user 2 sees only their own contact')
  t.absent(await restore1.getContact(u2.contact.id), 'user 1 cannot read user 2 data')
  t.absent(await restore2.getContact(u1.contact.id), 'user 2 cannot read user 1 data')
})

async function createDevice (t, seed, opts) {
  const store = new Corestore(await tmp(t))
  const book = await AddressBook.fromSeed(seed, store, { namespace: TEST_NAMESPACE, ...opts })
  t.teardown(() => closeIfOpen(book))
  return book
}

function deriveBootstrapKeyPair (seed, namespace = TEST_NAMESPACE) {
  return deriveSeedKeyPair(seed, {
    salt: ADDRESS_BOOK_SEED_SALT,
    info: namespace + ':' + ADDRESS_BOOK_BOOTSTRAP_WRITER_INFO
  })
}

function getWriterCores (base) {
  const cores = [base.local]
  for (const writer of base.activeWriters) cores.push(writer.core)
  return dedupeCores(cores)
}

async function mirroredCoreLengths (mirror, cores) {
  const result = []
  for (const source of cores) {
    const mirrored = mirror.store.get({ key: source.key })
    await mirrored.ready()
    await mirrored.update()
    result.push({
      key: b4a.toString(source.key, 'hex').slice(0, 8),
      sourceLength: source.length,
      mirrorLength: mirrored.length,
      contiguousLength: mirrored.contiguousLength
    })
  }
  return result
}

function dedupeCores (cores) {
  const seen = new Set()
  const result = []
  for (const core of cores) {
    const id = b4a.toString(core.key, 'hex')
    if (seen.has(id)) continue
    seen.add(id)
    result.push(core)
  }
  return result
}

async function waitFor (fn, label, { timeout = 20000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (err) {
      lastError = err
    }
    await delay(interval)
  }

  const error = new Error('Timed out waiting for ' + label)
  if (lastError) error.cause = lastError
  throw error
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function closeIfOpen (resource) {
  if (!resource || resource.closed || resource.closing) return
  await resource.close()
}
