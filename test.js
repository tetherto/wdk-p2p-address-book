import test from 'brittle'
import AddressBook, { ADDRESS_TYPES } from './index.js'
import Corestore from 'corestore'
import tmp from 'test-tmp'
import b4a from 'b4a'

import { encode, decode } from './spec/hyperdispatch/index.js'
import { deriveSeedKeyPair } from '@tetherto/wdk-utils'
import { sign } from './utils.js'

const TEST_SEED = b4a.alloc(64, 0xab)
const TEST_NAMESPACE = 'test'
const ADDRESS_BOOK_SEED_SALT = 'wdk-addressbook-v1'
const ADDRESS_BOOK_BOOTSTRAP_WRITER_INFO = 'bootstrap-writer'
const ADD_WRITER_ACTION = 1
const REMOVE_WRITER_ACTION = 2

test('basic CRUD - contacts', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })
  t.is(alice.name, 'Alice')
  t.ok(alice.id)
  t.ok(alice.createdAt)

  const got = await book.getContact(alice.id)
  t.is(got.name, 'Alice')

  await book.editContact(alice.id, { name: 'Alice Smith' })
  const updated = await book.getContact(alice.id)
  t.is(updated.name, 'Alice Smith')
  t.ok(updated.updatedAt >= alice.updatedAt)

  await book.deleteContact(alice.id)
  const deleted = await book.getContact(alice.id)
  t.is(deleted, null)

  await book.close()
})

test('basic CRUD - addresses', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })

  const addr = await book.addAddress(alice.id, {
    address: '0x1234567890abcdef',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum',
    label: 'Main'
  })

  t.is(addr.address, '0x1234567890abcdef')
  t.is(addr.type, ADDRESS_TYPES.EVM)
  t.is(addr.label, 'Main')
  t.is(addr.network, 'ethereum')

  const addrs = await book.listAddresses(alice.id)
  t.is(addrs.length, 1)

  await book.editAddress(addr.id, { label: 'Trading' })
  const updated = await book.listAddresses(alice.id)
  t.is(updated[0].label, 'Trading')

  await book.deleteAddress(addr.id)
  const empty = await book.listAddresses(alice.id)
  t.is(empty.length, 0)

  await book.close()
})

test('address input normalization', async function (t) {
  const book = await createBook(t)
  const alice = await book.addContact({ name: 'Alice' })

  const addr = await book.addAddress(alice.id, {
    address: '  0xabc  ',
    type: '  evm  ',
    network: '  Ethereum  ',
    label: '  Main wallet  '
  })

  t.is(addr.address, '0xabc')
  t.is(addr.type, ADDRESS_TYPES.EVM)
  t.is(addr.network, 'ethereum')
  t.is(addr.label, 'Main wallet')

  const updated = await book.editAddress(addr.id, {
    network: '  POLYGON  ',
    label: '   '
  })

  t.is(updated.network, 'polygon')
  t.is(updated.label, null)

  await book.close()
})

test('address input rejects invalid shape', async function (t) {
  const book = await createBook(t)
  const alice = await book.addContact({ name: 'Alice' })

  const cases = [
    {
      input: {
        address: '0xabc',
        type: ADDRESS_TYPES.EVM,
        networks: ['ethereum']
      },
      message: 'Use network instead of networks'
    },
    {
      input: {
        address: '',
        type: ADDRESS_TYPES.EVM,
        network: 'ethereum'
      },
      message: 'Address is required'
    },
    {
      input: {
        address: '0xabc',
        type: ADDRESS_TYPES.EVM,
        network: '   '
      },
      message: 'Address network is required'
    },
    {
      input: {
        address: '0xabc',
        type: ADDRESS_TYPES.EVM,
        network: 'ethereum',
        label: 123
      },
      message: 'Address label must be a string'
    }
  ]

  for (const { input, message } of cases) {
    try {
      await book.addAddress(alice.id, input)
      t.fail('Should have thrown')
    } catch (e) {
      t.ok(e.message.includes(message))
    }
  }

  await book.close()
})

test('contact name validation', async function (t) {
  const book = await createBook(t)

  const trimmed = await book.addContact({ name: '  Alice  ' })
  t.is(trimmed.name, 'Alice', 'name is trimmed')

  for (const bad of [undefined, '', '   ', 123]) {
    try {
      await book.addContact({ name: bad })
      t.fail('Should have thrown for ' + JSON.stringify(bad))
    } catch (e) {
      t.ok(e.message.includes('Contact name'), 'rejects ' + JSON.stringify(bad))
    }
  }

  try {
    await book.addContact({ name: 'x'.repeat(1000) })
    t.fail('Should have thrown for too-long name')
  } catch (e) {
    t.ok(e.message.includes('at most'), 'rejects too-long name')
  }

  await book.close()
})

test('cascade delete - deleting contact removes addresses', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })

  await book.addAddress(alice.id, {
    address: '0xaaa',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum'
  })
  await book.addAddress(alice.id, {
    address: '0xbbb',
    type: ADDRESS_TYPES.EVM,
    network: 'polygon'
  })

  let addrs = await book.listAddresses(alice.id)
  t.is(addrs.length, 2)

  await book.deleteContact(alice.id)

  addrs = await book.listAddresses(alice.id)
  t.is(addrs.length, 0)

  await book.close()
})

test('contacts sorted alphabetically', async function (t) {
  const book = await createBook(t)

  await book.addContact({ name: 'Charlie' })
  await book.addContact({ name: 'Alice' })
  await book.addContact({ name: 'Bob' })

  const list = await book.listContacts()
  t.is(list[0].name, 'Alice')
  t.is(list[1].name, 'Bob')
  t.is(list[2].name, 'Charlie')

  await book.close()
})

test('solana, ton, aptos and other address types', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })
  const inputs = [
    { address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', type: ADDRESS_TYPES.SOLANA, network: 'solana' },
    { address: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2', type: ADDRESS_TYPES.TON, network: 'ton' },
    { address: '0x' + 'a'.repeat(64), type: ADDRESS_TYPES.APTOS, network: 'aptos' },
    { address: 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu', type: ADDRESS_TYPES.OTHER, network: 'cosmos' }
  ]

  for (const input of inputs) {
    const addr = await book.addAddress(alice.id, input)
    t.is(addr.type, input.type)
  }

  const stored = await book.listAddresses(alice.id)
  t.alike(
    stored.map((a) => a.type).sort(),
    ['aptos', 'other', 'solana', 'ton']
  )

  await book.close()
})

test('UMA uniqueness', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })
  const bob = await book.addContact({ name: 'Bob' })

  await book.addAddress(alice.id, {
    address: '$alice@uma.me',
    type: ADDRESS_TYPES.UMA,
    network: 'ethereum'
  })

  try {
    await book.addAddress(bob.id, {
      address: '$alice@uma.me',
      type: ADDRESS_TYPES.UMA,
      network: 'polygon'
    })
    t.fail('Should have thrown')
  } catch (e) {
    t.ok(e.message.includes('UMA already exists'))
  }

  await book.close()
})

test('address + network uniqueness', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })
  const bob = await book.addContact({ name: 'Bob' })

  await book.addAddress(alice.id, {
    address: '0x123',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum'
  })

  await book.addAddress(bob.id, {
    address: '0x123',
    type: ADDRESS_TYPES.EVM,
    network: 'polygon'
  })
  t.pass('different network allowed')

  try {
    await book.addAddress(bob.id, {
      address: '0x123',
      type: ADDRESS_TYPES.EVM,
      network: 'ethereum'
    })
    t.fail('Should have thrown')
  } catch (e) {
    t.ok(e.message.includes('already saved for network'))
  }

  await book.close()
})

test('apply deterministically enforces uniqueness across raw appends', async function (t) {
  const book = await createBook(t)
  const alice = await book.addContact({ name: 'Alice' })

  // Bypass the API-layer check to mimic two un-synced writers; apply must keep one.
  const baseAddr = {
    contactId: alice.id,
    address: '0xdup',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum',
    label: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await book.base.append(encode('@wdk-addressbook/put-address', { ...baseAddr, id: 'addr-1' }))
  await book.base.append(encode('@wdk-addressbook/put-address', { ...baseAddr, id: 'addr-2' }))
  await book.base.update()

  const addrs = await book.listAddresses(alice.id)
  t.is(addrs.length, 1, 'address+network duplicate deduped in apply')
  t.is(addrs[0].id, 'addr-1', 'first op in linearized order wins')

  // Same for UMA uniqueness.
  const baseUma = {
    contactId: alice.id,
    address: '$alice@uma.me',
    type: ADDRESS_TYPES.UMA,
    network: 'ethereum',
    label: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await book.base.append(encode('@wdk-addressbook/put-address', { ...baseUma, id: 'uma-1' }))
  await book.base.append(
    encode('@wdk-addressbook/put-address', { ...baseUma, id: 'uma-2', network: 'polygon' })
  )
  await book.base.update()

  const umas = (await book.listAddresses(alice.id)).filter((a) => a.type === ADDRESS_TYPES.UMA)
  t.is(umas.length, 1, 'duplicate UMA deduped in apply')
  t.is(umas[0].id, 'uma-1', 'first UMA op wins')

  await book.close()
})

test('edit address enforces type and uniqueness', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })
  const bob = await book.addContact({ name: 'Bob' })

  const aliceAddress = await book.addAddress(alice.id, {
    address: '0xabc',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum'
  })

  const bobAddress = await book.addAddress(bob.id, {
    address: '0xdef',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum'
  })

  try {
    await book.editAddress(bobAddress.id, { address: aliceAddress.address })
    t.fail('Should have thrown')
  } catch (e) {
    t.ok(e.message.includes('already saved for network'))
  }

  try {
    await book.editAddress(bobAddress.id, { type: 'unsupported' })
    t.fail('Should have thrown')
  } catch (e) {
    t.ok(e.message.includes('Unsupported address type'))
  }

  await book.close()
})

test('search - matches name, address, label', async function (t) {
  const book = await createBook(t)

  const alice = await book.addContact({ name: 'Alice' })
  const bob = await book.addContact({ name: 'Bob' })

  await book.addAddress(alice.id, {
    address: '0xalice123',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum',
    label: 'Hot wallet'
  })

  await book.addAddress(bob.id, {
    address: '0xbob456',
    type: ADDRESS_TYPES.EVM,
    network: 'ethereum'
  })

  let results = await book.search('alice')
  t.is(results.length, 1)
  t.is(results[0].name, 'Alice')

  results = await book.search('bob456')
  t.is(results.length, 1)
  t.is(results[0].name, 'Bob')

  results = await book.search('hot wallet')
  t.is(results.length, 1)
  t.is(results[0].name, 'Alice')

  results = await book.search('zzz')
  t.is(results.length, 0)

  await book.close()
})

test('deterministic autobase key from seed', async function (t) {
  const store1 = new Corestore(await tmp(t))
  const book1 = await AddressBook.fromSeed(TEST_SEED, store1, {
    namespace: TEST_NAMESPACE,
    replicate: false
  })
  t.teardown(() => book1.close())

  t.ok(
    b4a.equals(book1.key, AddressBook.deriveAutobaseKey(deriveBootstrapKeyPair(TEST_SEED))),
    'key matches precomputed deriveAutobaseKey'
  )

  const store2 = new Corestore(await tmp(t))
  const book2 = await AddressBook.fromSeed(TEST_SEED, store2, {
    namespace: TEST_NAMESPACE,
    replicate: false
  })
  t.teardown(() => book2.close())

  t.ok(b4a.equals(book1.key, book2.key), 'same seed produces same autobase key')
})

test('different namespaces derive different books from the same seed', async function (t) {
  const book1 = await AddressBook.fromSeed(TEST_SEED, new Corestore(await tmp(t)), {
    namespace: 'tether-wallet',
    replicate: false
  })
  t.teardown(() => book1.close())

  const book2 = await AddressBook.fromSeed(TEST_SEED, new Corestore(await tmp(t)), {
    namespace: 'other-wallet',
    replicate: false
  })
  t.teardown(() => book2.close())

  t.absent(b4a.equals(book1.key, book2.key), 'namespace isolates the derived address book')
})

test('two namespaces can share one corestore without colliding', async function (t) {
  const store = new Corestore(await tmp(t))

  const personal = await AddressBook.fromSeed(TEST_SEED, store, {
    namespace: 'personal',
    replicate: false
  })
  t.teardown(() => personal.close())

  const business = await AddressBook.fromSeed(TEST_SEED, store, {
    namespace: 'business',
    replicate: false
  })
  t.teardown(() => business.close())

  t.absent(b4a.equals(personal.key, business.key), 'distinct books')
  t.absent(
    b4a.equals(personal.writerKey, business.writerKey),
    'distinct device-writer cores from the shared store'
  )

  await personal.create()
  await business.create()
  const alice = await personal.addContact({ name: 'Alice' })
  await business.addContact({ name: 'Bob' })

  t.is((await personal.listContacts()).length, 1, 'personal book isolated')
  t.is((await business.listContacts()).length, 1, 'business book isolated')
  t.absent(await business.getContact(alice.id), 'business cannot see personal data')
})

test('created device uses a device-specific writer and reopens writable', async function (t) {
  const dir = await tmp(t)

  const store1 = new Corestore(dir)
  const book = await AddressBook.fromSeed(TEST_SEED, store1, {
    namespace: TEST_NAMESPACE,
    replicate: false
  })
  await book.create()
  t.ok(book.writable, 'creator is writable after create()')
  t.absent(
    b4a.equals(book.writerKey, deriveBootstrapKeyPair(TEST_SEED).publicKey),
    'creator writes as a device-specific writer, not the bootstrap identity'
  )
  const alice = await book.addContact({ name: 'Alice' })
  await book.close()
  await store1.close()

  const store2 = new Corestore(dir)
  const reopened = await AddressBook.fromSeed(TEST_SEED, store2, {
    namespace: TEST_NAMESPACE,
    replicate: false
  })
  t.teardown(async () => {
    await reopened.close()
    await store2.close()
  })

  t.ok(reopened.writable, 'reopened device is writable')
  t.is((await reopened.getContact(alice.id)).name, 'Alice', 'reopened device kept data')
  const bob = await reopened.addContact({ name: 'Bob' })
  t.is(bob.name, 'Bob', 'reopened device can keep writing')
})

test('optimistic self-admit is authorized by a seed-derived bootstrap proof', async function (t) {
  // create()'s enrollment path: admission must require the seed, not just "op came from this core".
  const store = new Corestore(await tmp(t))
  const book = await AddressBook.fromSeed(TEST_SEED, store, {
    namespace: TEST_NAMESPACE,
    replicate: false
  })
  t.teardown(async () => {
    await book.close()
    await store.close()
  })
  t.absent(book.writable, 'starts read-only (deferred enrollment)')

  const selfAdmit = async (proof) => {
    const writer = { key: book.writerKey, name: null }
    if (proof) writer.proof = proof
    await book.base.append(encode('@wdk-addressbook/add-writer', writer), { optimistic: true })
    await book.base.update()
  }

  // Read access without the bootstrap secret must not mint a writer.
  const foreign = deriveBootstrapKeyPair(b4a.alloc(64, 0x11))
  await selfAdmit(sign(book.writerKey, foreign.secretKey))
  t.absent(book.writable, 'invalid bootstrap proof does not admit a writer')

  await selfAdmit(null)
  t.absent(book.writable, 'missing proof does not admit a writer')

  // Self-bind: a valid proof can't admit a different device's key.
  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const otherKey = deriveBootstrapKeyPair(b4a.alloc(64, 0x22)).publicKey
  await book.base.append(
    encode('@wdk-addressbook/add-writer', { key: otherKey, name: null, proof: sign(otherKey, bootstrap.secretKey) }),
    { optimistic: true }
  )
  await book.base.update()
  t.absent(await book.getWriter(otherKey), 'valid proof for a different key is rejected (self-bind)')
  t.absent(book.writable, 'still read-only after every rejected self-admit')

  // The seed holder's bootstrap secret authorizes this device's own writer.
  await selfAdmit(sign(book.writerKey, bootstrap.secretKey))
  const deadline = Date.now() + 5000
  while (!book.writable && Date.now() < deadline) {
    await book.base.update()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  t.ok(book.writable, 'valid bootstrap proof admits this device as a writer')
})

test('removeMirror removes the key from the in-memory peering set, not just the persisted record', async function (t) {
  const book = await createBook(t)

  const mirrorKey = b4a.alloc(32, 0x99)
  await book.addMirror(mirrorKey)

  t.ok(
    book.mirrors.some((m) => b4a.equals(m, mirrorKey)),
    'addMirror tracks the key in the in-memory peering set'
  )
  t.ok(
    (await book.listMirrors()).some((m) => b4a.equals(m.key, mirrorKey)),
    'addMirror persists the key'
  )

  await book.removeMirror(mirrorKey)

  t.absent(
    (await book.listMirrors()).some((m) => b4a.equals(m.key, mirrorKey)),
    'removeMirror removes the persisted record'
  )
  // _updatePeering() unions book.mirrors with the persisted list on every call, so a
  // key left behind here keeps getting re-added to the peering set even though the
  // persisted record (checked above) says it was removed.
  t.absent(
    book.mirrors.some((m) => b4a.equals(m, mirrorKey)),
    'removeMirror also drops the key from the in-memory peering set'
  )

  await book.close()
})

test('a removed device cannot re-admit itself by replaying its own add-writer entries', async function (t) {
  const a = await openDevice(t)
  await a.book.create()
  const b = await openDevice(t)
  replicate(t, a.book, b.book)
  await b.book.create()
  await waitUntil(async () => !!(await a.book.getWriter(b.book.writerKey)), [a.book, b.book])

  await a.book.removeWriter(b.book.writerKey)
  await waitUntil(async () => !b.book.writable, [a.book, b.book])

  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const replays = [
    ...(await readLocalAddWriterOps(b.book)),
    { name: '@wdk-addressbook/add-writer', value: { key: b.book.writerKey, name: null, proof: sign(b.book.writerKey, bootstrap.secretKey) } }
  ]
  for (const { name, value } of replays) {
    await b.book.base.append(encode(name, value), { optimistic: true })
  }
  await waitForCore(a.book, b.book.writerKey, b.book.base.local.length)
  await a.book.base.update()

  t.is(replays.length, 2)
  t.is(await a.book.getWriter(b.book.writerKey), null)
  t.alike((await a.book.listWriters().toArray()).map((w) => w.key), [a.book.writerKey])
  t.absent(b.book.writable)
})

test('an active writer cannot add a writer key without a valid seed proof', async function (t) {
  const { book } = await openDevice(t)
  await book.create()
  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const foreign = deriveBootstrapKeyPair(b4a.alloc(64, 0x11))
  const writerKey = b4a.alloc(32, 0x77)

  await book.base.append(encode('@wdk-addressbook/add-writer', { key: writerKey, name: 'no proof' }))
  await book.base.update()

  t.is(await book.getWriter(writerKey), null)

  await book.base.append(encode('@wdk-addressbook/add-writer-v2', {
    key: writerKey, name: 'foreign proof', epoch: 0, proof: writerProof(ADD_WRITER_ACTION, writerKey, 0, foreign.secretKey)
  }))
  await book.base.append(encode('@wdk-addressbook/add-writer-v2', {
    key: writerKey, name: 'remove proof', epoch: 0, proof: writerProof(REMOVE_WRITER_ACTION, writerKey, 0, bootstrap.secretKey)
  }))
  await book.base.append(encode('@wdk-addressbook/add-writer-v2', {
    key: writerKey, name: 'future epoch', epoch: 1, proof: writerProof(ADD_WRITER_ACTION, writerKey, 1, bootstrap.secretKey)
  }))
  await book.base.update()

  t.is(await book.getWriter(writerKey), null)

  await book.addWriter({ key: writerKey, name: 'seed holder' })
  await book.base.update()

  t.alike(await book.getWriter(writerKey), { key: writerKey, name: 'seed holder', proof: null })
})

test('remove-writer without a valid seed proof for the key\'s current epoch is ignored', async function (t) {
  const { book } = await openDevice(t)
  await book.create()
  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const foreign = deriveBootstrapKeyPair(b4a.alloc(64, 0x11))
  const writerKey = b4a.alloc(32, 0x77)
  await book.addWriter({ key: writerKey, name: 'removed' })
  await book.removeWriter(writerKey)
  await book.addWriter({ key: writerKey, name: 'kept' })

  await book.base.append(encode('@wdk-addressbook/remove-writer', { key: writerKey }))
  await book.base.update()

  t.alike(await book.getWriter(writerKey), { key: writerKey, name: 'kept', proof: null })

  await book.base.append(encode('@wdk-addressbook/remove-writer-v2', {
    key: writerKey, epoch: 1, proof: writerProof(REMOVE_WRITER_ACTION, writerKey, 1, foreign.secretKey)
  }))
  await book.base.append(encode('@wdk-addressbook/remove-writer-v2', {
    key: writerKey, epoch: 1, proof: writerProof(ADD_WRITER_ACTION, writerKey, 1, bootstrap.secretKey)
  }))
  await book.base.append(encode('@wdk-addressbook/remove-writer-v2', {
    key: writerKey, epoch: 0, proof: writerProof(REMOVE_WRITER_ACTION, writerKey, 0, bootstrap.secretKey)
  }))
  await book.base.update()

  t.alike(await book.getWriter(writerKey), { key: writerKey, name: 'kept', proof: null })

  await book.removeWriter(writerKey)
  await book.base.update()

  t.is(await book.getWriter(writerKey), null)
})

test('a seed holder can re-enroll a device after it was removed', async function (t) {
  const a = await openDevice(t)
  await a.book.create()
  const b = await openDevice(t)
  replicate(t, a.book, b.book)
  await b.book.create()
  await waitUntil(async () => !!(await a.book.getWriter(b.book.writerKey)), [a.book, b.book])
  await a.book.removeWriter(b.book.writerKey)
  await waitUntil(async () => !b.book.writable, [a.book, b.book])

  await b.book.create()
  await waitUntil(async () => !!(await a.book.getWriter(b.book.writerKey)), [a.book, b.book])

  t.ok(b.book.writable)
  t.alike(await a.book.getWriter(b.book.writerKey), { key: b.book.writerKey, name: null, proof: null })
  const contact = await b.book.addContact({ name: 'Bob' })
  await waitUntil(async () => !!(await a.book.getContact(contact.id)), [a.book, b.book])
  t.is((await a.book.getContact(contact.id)).name, 'Bob')
})

test('legacy writer history replays unchanged, and legacy writer ops are ignored after the switch', async function (t) {
  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const a = await openDevice(t)
  const removedKey = b4a.alloc(32, 0x77)
  const keptKey = b4a.alloc(32, 0x88)
  await a.book.base.append(encode('@wdk-addressbook/add-writer', {
    key: a.book.writerKey, name: 'A', proof: sign(a.book.writerKey, bootstrap.secretKey)
  }), { optimistic: true })
  await waitUntil(async () => a.book.writable, [a.book])
  await a.book.base.append(encode('@wdk-addressbook/put-contact', { id: 'legacy', name: 'Alice', username: null, createdAt: 1, updatedAt: 1 }))
  await a.book.base.append(encode('@wdk-addressbook/add-writer', { key: removedKey, name: 'removed' }))
  await a.book.base.append(encode('@wdk-addressbook/remove-writer', { key: removedKey }))
  await a.book.base.append(encode('@wdk-addressbook/add-writer', { key: keptKey, name: 'kept' }))
  await a.book.base.update()

  const b = await openDevice(t)
  replicate(t, a.book, b.book)
  await waitUntil(async () => !!(await b.book.getContact('legacy')), [a.book, b.book])
  await b.book.base.update()

  const expectedWriters = sortByKey([
    { key: a.book.writerKey, name: 'A', proof: null },
    { key: keptKey, name: 'kept', proof: null }
  ])
  t.alike(await a.book.listWriters().toArray(), expectedWriters)
  t.alike(await b.book.listWriters().toArray(), expectedWriters)
  t.alike(await b.book.listContacts(), [{ id: 'legacy', name: 'Alice', username: null, createdAt: 1, updatedAt: 1 }])

  const lateKey = b4a.alloc(32, 0x99)
  await a.book.addWriter({ key: removedKey, name: 'readded' })
  await a.book.base.append(encode('@wdk-addressbook/remove-writer', { key: keptKey }))
  await a.book.base.append(encode('@wdk-addressbook/add-writer', { key: lateKey, name: 'late' }))
  await a.book.base.update()

  t.alike(await a.book.listWriters().toArray(), sortByKey([
    ...expectedWriters,
    { key: removedKey, name: 'readded', proof: null }
  ]))
})

test('reopening a writable legacy book switches it to the signed writer protocol', async function (t) {
  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const dir = await tmp(t)
  const legacy = await openDevice(t, dir)
  await legacy.book.base.append(encode('@wdk-addressbook/add-writer', {
    key: legacy.book.writerKey, name: null, proof: sign(legacy.book.writerKey, bootstrap.secretKey)
  }), { optimistic: true })
  await waitUntil(async () => legacy.book.writable, [legacy.book])
  await legacy.book.close()
  await legacy.store.close()

  const reopened = await openDevice(t, dir)
  await reopened.book.base.update()
  const writerKey = b4a.alloc(32, 0x77)
  await reopened.book.base.append(encode('@wdk-addressbook/add-writer', { key: writerKey, name: 'no proof' }))
  await reopened.book.base.update()

  t.is(await reopened.book.getWriter(writerKey), null)
})

test('a device that joins from a copy behind an earlier removal becomes a writer', async function (t) {
  const [a, e] = await openDevicesInKeyOrder(t)
  await a.book.create()
  const b = await openDevice(t)
  replicate(t, a.book, b.book)
  await b.book.create()
  await waitUntil(async () => !!(await a.book.getWriter(b.book.writerKey)), [a.book, b.book])
  const disconnect = replicate(t, a.book, e.book)
  await waitUntil(async () => !!(await e.book.getWriter(b.book.writerKey)), [a.book, e.book])
  disconnect()
  await a.book.removeWriter(b.book.writerKey)
  await waitUntil(async () => !b.book.writable, [a.book, b.book])

  await e.book.create()
  const contact = await e.book.addContact({ name: 'Erin' })
  replicate(t, a.book, e.book)
  await waitForSync(a.book, e.book)

  t.ok(e.book.writable)
  t.alike(await a.book.getWriter(e.book.writerKey), { key: e.book.writerKey, name: null, proof: null })
  t.alike(await a.book.getContact(contact.id), contact)
})

test('concurrent writer changes from two devices all hold after they sync', async function (t) {
  const a = await openDevice(t)
  await a.book.create()
  const b = await openDevice(t)
  const disconnect = replicate(t, a.book, b.book)
  await b.book.create()
  const removedByA = b4a.alloc(32, 0x11)
  const removedByB = b4a.alloc(32, 0x22)
  const addedByB = b4a.alloc(32, 0x44)
  await a.book.addWriter({ key: removedByA, name: 'removed by A' })
  await a.book.addWriter({ key: removedByB, name: 'removed by B' })
  await waitUntil(async () => (await b.book.listWriters().toArray()).length === 4, [a.book, b.book])
  disconnect()

  await a.book.removeWriter(removedByA)
  await b.book.removeWriter(removedByB)
  await b.book.addWriter({ key: addedByB, name: 'added by B' })
  replicate(t, a.book, b.book)
  await waitForSync(a.book, b.book)

  const expectedWriters = sortByKey([
    { key: a.book.writerKey, name: null, proof: null },
    { key: b.book.writerKey, name: null, proof: null },
    { key: addedByB, name: 'added by B', proof: null }
  ])
  t.alike(await a.book.listWriters().toArray(), expectedWriters)
  t.alike(await b.book.listWriters().toArray(), expectedWriters)
})

test('a removal on a legacy book stops the removed device from replaying its legacy proof', async function (t) {
  const bootstrap = deriveBootstrapKeyPair(TEST_SEED)
  const legacyAdd = (key) => encode('@wdk-addressbook/add-writer', { key, name: null, proof: sign(key, bootstrap.secretKey) })
  const a = await openDevice(t)
  await a.book.base.append(legacyAdd(a.book.writerKey), { optimistic: true })
  await waitUntil(async () => a.book.writable, [a.book])
  const b = await openDevice(t)
  replicate(t, a.book, b.book)
  await b.book.base.append(legacyAdd(b.book.writerKey), { optimistic: true })
  await waitUntil(async () => !!(await a.book.getWriter(b.book.writerKey)) && b.book.writable, [a.book, b.book])
  await a.book.removeWriter(b.book.writerKey)
  await waitUntil(async () => !b.book.writable, [a.book, b.book])

  await b.book.base.append(legacyAdd(b.book.writerKey), { optimistic: true })
  await waitForCore(a.book, b.book.writerKey, b.book.base.local.length)
  await a.book.base.update()

  t.is(await a.book.getWriter(b.book.writerKey), null)
  t.alike(await a.book.listWriters().toArray(), [{ key: a.book.writerKey, name: null, proof: null }])
  t.absent(b.book.writable)
})

test('removing the last writer of a book is ignored', async function (t) {
  const { book } = await openDevice(t)
  await book.create()

  await book.removeWriter(book.writerKey)
  await book.base.update()

  t.ok(book.writable)
  t.alike(await book.getWriter(book.writerKey), { key: book.writerKey, name: null, proof: null })
  const contact = await book.addContact({ name: 'Alice' })
  t.is((await book.getContact(contact.id)).name, 'Alice')
})

test('addWriter and removeWriter throw on a book not constructed from a seed', async function (t) {
  const { book } = await openDevice(t)
  const store = new Corestore(await tmp(t))
  const plain = new AddressBook(store, { key: book.key, encryptionKey: book.encryptionKey, replicate: false })
  await plain.ready()
  t.teardown(async () => {
    await plain.close()
    await store.close()
  })
  const writerKey = b4a.alloc(32, 0x77)

  await t.exception(plain.addWriter(writerKey), /^Error: address book was not constructed from a seed; cannot add a writer$/)
  await t.exception(plain.removeWriter(writerKey), /^Error: address book was not constructed from a seed; cannot remove a writer$/)
})

let seedCounter = 0

async function createBook (t, opts) {
  const store = new Corestore(await tmp(t))
  const seed = b4a.alloc(64, seedCounter++ % 256)
  const book = await AddressBook.fromSeed(seed, store, {
    namespace: TEST_NAMESPACE,
    replicate: false,
    ...opts
  })
  await book.create() // construct is read-only; enroll a fresh book for these tests
  t.teardown(async () => {
    await book.close()
    await store.close()
  })
  return book
}

function deriveBootstrapKeyPair (seed, namespace = TEST_NAMESPACE) {
  return deriveSeedKeyPair(seed, {
    salt: ADDRESS_BOOK_SEED_SALT,
    info: namespace + ':' + ADDRESS_BOOK_BOOTSTRAP_WRITER_INFO
  })
}

async function openDevice (t, dir) {
  const store = new Corestore(dir || await tmp(t))
  const book = await AddressBook.fromSeed(TEST_SEED, store, {
    namespace: TEST_NAMESPACE,
    replicate: false
  })
  t.teardown(async () => {
    await book.close()
    await store.close()
  })
  return { book, store }
}

async function openDevicesInKeyOrder (t) {
  const devices = [await openDevice(t), await openDevice(t)]
  return devices.sort((x, y) => b4a.compare(x.book.writerKey, y.book.writerKey))
}

function replicate (t, a, b) {
  const s1 = a.base.replicate(true)
  const s2 = b.base.replicate(false)
  s1.pipe(s2).pipe(s1)
  const disconnect = () => {
    s1.destroy()
    s2.destroy()
  }
  t.teardown(disconnect, { order: -1 })
  return disconnect
}

async function waitUntil (fn, books, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const book of books) await book.base.update()
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for condition')
}

async function waitForCore (book, key, length) {
  const core = book.store.get({ key })
  await core.ready()
  await waitUntil(async () => core.contiguousLength >= length, [book])
  await core.close()
}

async function waitForSync (a, b) {
  await waitForCore(a, b.writerKey, b.base.local.length)
  await waitForCore(b, a.writerKey, a.base.local.length)
  await a.base.update()
  await b.base.update()
}

async function readLocalAddWriterOps (book) {
  const ops = []
  for (let i = 0; i < book.base.local.length; i++) {
    const block = await book.base.local.get(i)
    const { name, value } = decode(block.node.value)
    if (name.startsWith('@wdk-addressbook/add-writer')) ops.push({ name, value })
  }
  return ops
}

function writerProof (action, key, epoch, secretKey) {
  const message = b4a.alloc(41)
  message[0] = action
  message.set(key, 1)
  new DataView(message.buffer, message.byteOffset, message.byteLength).setBigUint64(33, BigInt(epoch))
  return sign(message, secretKey)
}

function sortByKey (writers) {
  return writers.sort((a, b) => b4a.compare(a.key, b.key))
}
