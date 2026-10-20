import test from 'brittle'
import AddressBook, { ADDRESS_TYPES } from './index.js'
import Corestore from 'corestore'
import tmp from 'test-tmp'
import b4a from 'b4a'

import { encode } from './spec/hyperdispatch/index.js'
import { deriveSeedKeyPair } from '@tetherto/wdk-utils'
import { sign } from './utils.js'

const TEST_SEED = b4a.alloc(64, 0xab)
const TEST_NAMESPACE = 'test'
const ADDRESS_BOOK_SEED_SALT = 'wdk-addressbook-v1'
const ADDRESS_BOOK_BOOTSTRAP_WRITER_INFO = 'bootstrap-writer'

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
