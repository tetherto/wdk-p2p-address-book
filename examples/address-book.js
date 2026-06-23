// Interactive address-book CLI. Opens (or restores, or creates) a book at a
// given storage path, then drops into a menu loop where you can create, update
// and delete contacts (and their addresses). The current contact list is
// reprinted before every prompt.
//
// It also has a "Live watch" mode that re-renders the list in place as changes
// sync in from other devices/processes. Run two instances with the same mirror
// key but different storage paths, edit in one, and watch it appear in the
// other's live view.
//
// This uses the unified "restore with timeout" pattern: every device makes the
// same `fromSeed` call. If a book already exists on the mirror it syncs and
// this device joins it; if nothing arrives within `timeout` it bootstraps a
// fresh genesis (same deterministic key, so it is still "the" book).
//
// Usage:
//   node examples/address-book.js <storage-path> [mirror-key]
//
//   storage-path  required. where this device persists its Corestore.
//   mirror-key    optional. the blind peer key printed by blind-peer.js.
//                 when given, this device syncs through that mirror.
//
// The seed is hard-coded for the demo (same seed => same book on every device).

import readline from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import logUpdate from 'log-update'
import Corestore from 'corestore'
import b4a from 'b4a'
import AddressBook, { ADDRESS_TYPES } from '../index.js'

// Hard-coded demo seed: 64 BIP-39 seed BYTES (not a mnemonic). Every device
// that uses this same seed + namespace converges on the same address book.
const SEED = b4a.alloc(64, 0x42)
const NAMESPACE = 'tether-wallet'
const ADDRESS_TYPE_LIST = Object.values(ADDRESS_TYPES).join(', ')

const FIRST_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Olivia', 'Peggy', 'Trent', 'Victor', 'Walter']
const LAST_NAMES = ['Smith', 'Johnson', 'Lee', 'Patel', 'Garcia', 'Kim', 'Nguyen', 'Brown', 'Rossi', 'Khan', 'Silva', 'Novak']
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const storagePath = process.argv[2]
const mirrorKey = process.argv[3] || null

if (!storagePath) {
  console.error('Usage: node examples/address-book.js <storage-path> [mirror-key]')
  process.exit(1)
}

const store = new Corestore(storagePath)

const book = await AddressBook.fromSeed(SEED, store, {
  namespace: NAMESPACE,
  mirrors: mirrorKey ? [mirrorKey] : [],
  timeout: 20000
})

// Persist the mirror so it is remembered across reopens and the blind peer
// keeps mirroring this book. Safe (idempotent) to call on every boot.
if (mirrorKey) await book.addMirror(mirrorKey)

console.log('address book ready')
console.log('  storage:  ' + storagePath)
console.log('  mirror:   ' + (mirrorKey || '(none)'))
console.log('  writable: ' + book.writable)

const rl = readline.createInterface({ input, output })
const nextLine = createLineReader(rl)

let running = true
while (running) {
  await displayContacts(book)

  console.log('')
  console.log('Options:')
  console.log('  1. Create new entry')
  console.log('  2. Update old entry')
  console.log('  3. Delete old entry')
  console.log('  4. Create 5 random contacts')
  console.log('  5. Live watch (auto-refresh on sync)')
  console.log('  6. Exit')

  const choice = await ask('Choose an option: ')
  if (choice === null) break

  try {
    switch (choice) {
      case '1':
        await handleCreate()
        break
      case '2':
        await handleUpdate()
        break
      case '3':
        await handleDelete()
        break
      case '4':
        await handleCreateRandom(5)
        break
      case '5':
        await handleWatch()
        break
      case '6':
      case 'q':
      case 'exit':
        running = false
        break
      default:
        console.log('Unknown option: ' + choice)
    }
  } catch (err) {
    console.log('Error: ' + err.message)
  }
}

rl.close()
await book.close()
await store.close()
console.log('Bye.')

async function displayContacts (book) {
  const contacts = await book.listContacts()
  console.log('')
  console.log('=== Contacts (' + contacts.length + ') ===')
  if (contacts.length === 0) {
    console.log('  (none yet)')
    return
  }
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]
    console.log('  ' + (i + 1) + '. ' + contact.name)
    const addresses = await book.listAddresses(contact.id)
    if (addresses.length === 0) {
      console.log('       (no addresses)')
      continue
    }
    for (const addr of addresses) {
      const label = addr.label ? ' (' + addr.label + ')' : ''
      console.log('       - ' + addr.type + '/' + addr.network + ': ' + addr.address + label)
    }
  }
}

async function handleCreate () {
  const name = await ask('New contact name: ')
  if (name === null) return
  const contact = await book.addContact({ name })
  console.log('Created "' + contact.name + '".')

  while (await confirm('Add an address to ' + contact.name + '?')) {
    const address = await promptAddress()
    if (!address) continue
    try {
      await book.addAddress(contact.id, address)
      console.log('  address added.')
    } catch (err) {
      console.log('  could not add address: ' + err.message)
    }
  }
}

async function handleCreateRandom (count) {
  for (let i = 0; i < count; i++) {
    const name = randomName()
    let contact
    try {
      contact = await book.addContact({ name })
    } catch (err) {
      console.log('  skipped "' + name + '": ' + err.message)
      continue
    }

    const address = randomAddress()
    try {
      await book.addAddress(contact.id, address)
      console.log('  created "' + contact.name + '" with ' + address.type + '/' + address.network)
    } catch (err) {
      console.log('  created "' + contact.name + '" (address skipped: ' + err.message + ')')
    }
  }
}

// Live view: re-renders the contact list in place whenever the autobase
// updates (local edits or sync from other devices via the mirror), plus a
// once-per-second heartbeat for the clock/spinner. Press Enter to return.
async function handleWatch () {
  let frame = 0
  let syncs = 0
  let lastSyncAt = null
  let rendering = false
  let renderQueued = false

  async function render () {
    if (rendering) {
      renderQueued = true
      return
    }
    rendering = true
    try {
      const contacts = await book.listContacts()
      const lines = []
      lines.push('Live watch ' + SPINNER[frame % SPINNER.length] + '  ' + new Date().toLocaleTimeString())
      lines.push('  storage: ' + storagePath)
      lines.push('  mirror:  ' + (mirrorKey || '(none)'))
      lines.push('  syncs:   ' + syncs + (lastSyncAt ? '  (last ' + secondsAgo(lastSyncAt) + 's ago)' : ''))
      lines.push('')
      lines.push('Contacts (' + contacts.length + '):')
      if (contacts.length === 0) {
        lines.push('  (none yet)')
      } else {
        for (let i = 0; i < contacts.length; i++) {
          const contact = contacts[i]
          lines.push('  ' + (i + 1) + '. ' + contact.name)
          const addresses = await book.listAddresses(contact.id)
          for (const addr of addresses) {
            const label = addr.label ? ' (' + addr.label + ')' : ''
            lines.push('       - ' + addr.type + '/' + addr.network + ': ' + addr.address + label)
          }
        }
      }
      lines.push('')
      lines.push('Press Enter to return to the menu.')
      logUpdate(lines.join('\n'))
    } finally {
      rendering = false
      if (renderQueued) {
        renderQueued = false
        render()
      }
    }
  }

  function onUpdate () {
    syncs++
    lastSyncAt = Date.now()
    render()
  }

  book.on('update', onUpdate)
  const ticker = setInterval(() => {
    frame++
    render()
  }, 1000)

  await render()
  await nextLine() // resolves on Enter (or end-of-input)

  clearInterval(ticker)
  book.off('update', onUpdate)
  logUpdate.done()
}

async function handleUpdate () {
  const contact = await pickContact('update')
  if (!contact) return

  console.log('')
  console.log('Update "' + contact.name + '":')
  console.log('  1. Rename contact')
  console.log('  2. Add address')
  console.log('  3. Remove address')
  console.log('  4. Back')
  const choice = await ask('Choose an option: ')

  switch (choice) {
    case '1': {
      const name = await ask('New name: ')
      if (name === null) return
      const updated = await book.editContact(contact.id, { name })
      console.log('Renamed to "' + updated.name + '".')
      break
    }
    case '2': {
      const address = await promptAddress()
      if (!address) return
      await book.addAddress(contact.id, address)
      console.log('Address added.')
      break
    }
    case '3': {
      await removeAddress(contact)
      break
    }
    default:
      break
  }
}

async function handleDelete () {
  const contact = await pickContact('delete')
  if (!contact) return
  if (!(await confirm('Delete "' + contact.name + '" and all its addresses?'))) {
    console.log('Cancelled.')
    return
  }
  await book.deleteContact(contact.id)
  console.log('Deleted "' + contact.name + '".')
}

async function removeAddress (contact) {
  const addresses = await book.listAddresses(contact.id)
  if (addresses.length === 0) {
    console.log('That contact has no addresses.')
    return
  }
  addresses.forEach((addr, i) => {
    const label = addr.label ? ' (' + addr.label + ')' : ''
    console.log('  ' + (i + 1) + '. ' + addr.type + '/' + addr.network + ': ' + addr.address + label)
  })
  const addr = await pickFromList(addresses, 'remove')
  if (!addr) return
  await book.deleteAddress(addr.id)
  console.log('Address removed.')
}

async function promptAddress () {
  const address = await ask('  address: ')
  if (!address) {
    if (address !== null) console.log('  skipped (no address entered).')
    return null
  }
  const type = await ask('  type (' + ADDRESS_TYPE_LIST + '): ')
  const network = await ask('  network (e.g. ethereum): ')
  const label = await ask('  label (optional): ')
  return {
    address,
    type: type || '',
    network: network || '',
    label: label || undefined
  }
}

async function pickContact (verb) {
  const contacts = await book.listContacts()
  if (contacts.length === 0) {
    console.log('No contacts to ' + verb + ' yet.')
    return null
  }
  contacts.forEach((contact, i) => console.log('  ' + (i + 1) + '. ' + contact.name))
  return pickFromList(contacts, verb)
}

async function pickFromList (items, verb) {
  const answer = await ask('Which one to ' + verb + '? (number): ')
  if (!answer) return null
  const index = Number.parseInt(answer, 10) - 1
  if (Number.isNaN(index) || index < 0 || index >= items.length) {
    console.log('Invalid selection.')
    return null
  }
  return items[index]
}

async function confirm (question) {
  const answer = await ask(question + ' (y/N): ')
  return answer === 'y' || answer === 'yes'
}

function randomName () {
  return pick(FIRST_NAMES) + ' ' + pick(LAST_NAMES)
}

function randomAddress () {
  const variants = [
    () => ({ address: '0x' + randomHex(40), type: ADDRESS_TYPES.EVM, network: pick(['ethereum', 'polygon', 'arbitrum']), label: 'Wallet' }),
    () => ({ address: 'bc1q' + randomHex(38), type: ADDRESS_TYPES.BITCOIN, network: 'bitcoin', label: 'BTC' }),
    () => ({ address: '$' + randomHex(8) + '@uma.me', type: ADDRESS_TYPES.UMA, network: 'ethereum' }),
    () => ({ address: 'T' + randomHex(33), type: ADDRESS_TYPES.TRON, network: 'tron', label: 'TRX' })
  ]
  return pick(variants)()
}

function pick (arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function secondsAgo (timestamp) {
  return Math.max(0, Math.round((Date.now() - timestamp) / 1000))
}

function randomHex (length) {
  let out = ''
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16)
  return out.slice(0, length)
}

// Prints a prompt and resolves with the next line of input (trimmed), or null
// on end-of-input. Built on the readline 'line' event so it works the same for
// interactive TTYs and piped stdin (unlike readline/promises `question`, which
// hangs on its second call when stdin is a pipe).
async function ask (prompt) {
  output.write(prompt)
  const line = await nextLine()
  return line === null ? null : line.trim()
}

function createLineReader (rl) {
  const queue = []
  let pending = null
  let ended = false

  rl.on('line', (line) => {
    if (pending) {
      const resolve = pending
      pending = null
      resolve(line)
    } else {
      queue.push(line)
    }
  })

  rl.on('close', () => {
    ended = true
    if (pending) {
      const resolve = pending
      pending = null
      resolve(null)
    }
  })

  return function nextLine () {
    if (queue.length > 0) return Promise.resolve(queue.shift())
    if (ended) return Promise.resolve(null)
    return new Promise((resolve) => { pending = resolve })
  }
}
