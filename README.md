# @tetherto/wdk-p2p-address-book

Encrypted, multi-device contact/address book built on Autobase. All keys are derived from the wallet seed, data syncs peer-to-peer (and via always-on blind peers), and the backend only ever sees opaque encrypted blocks.

ESM, Node + Bare compatible.

## Install

```
npm install @tetherto/wdk-p2p-address-book
```

## Example: from a seed to an address book

Seed derivation uses HKDF helpers from `@tetherto/wdk-utils` (mirrored in this repo's `utils.js`). The salt/info labels are chosen at the app layer:

```js
import Corestore from 'corestore'
import AddressBook from '@tetherto/wdk-p2p-address-book'
import { deriveSeedKey, deriveSeedKeyPair } from '@tetherto/wdk-utils'

const SALT = 'wdk-addressbook-v1'

// `seed` is the BIP-39 seed BYTES (not the mnemonic string)
const encryptionKey = deriveSeedKey(seed, { salt: SALT, info: 'autobase-encryption' })
const bootstrapKeyPair = deriveSeedKeyPair(seed, { salt: SALT, info: 'bootstrap-writer' })

// The autobase key is deterministic from the bootstrap keypair — no storage needed.
const key = AddressBook.deriveAutobaseKey(bootstrapKeyPair)

// First device: create. Establishes genesis and enrolls this device's own writer.
const store = new Corestore('./addressbook')
const book = await AddressBook.create(store, { keyPair: bootstrapKeyPair, encryptionKey })

// `mirrorKey` is a blind peer's public key (see "How sync works" below) — one
// static value, the same for every user, shipped in app/BE config. Registering it
// asks the peer to mirror THIS user's book.
await book.addMirror(mirrorKey)
await book.addContact({ name: 'Alice' })

// On another device (restore): pass the same mirrorKey up front — a fresh device
// can't read the saved mirror record until it has synced from the mirror.
const restored = await AddressBook.open(store, { key, encryptionKey, mirrors: [mirrorKey] })
await restored.enrollLocalWriter({ keyPair: bootstrapKeyPair, name: 'iPhone' })
await restored.addContact({ name: 'Bob' })
```

The bootstrap keypair is used only to seed the genesis and authorize each device's writer — never as a long-lived writer. Conflicts resolve last-write-wins.

## How sync works

There is **one address book (Autobase) per user**, identified by a key derived from that user's seed (`deriveAutobaseKey`). A **blind peer** is shared infrastructure: a single always-on node (or a small static fleet) that mirrors _many_ users' address books and stores only opaque encrypted blocks — it can't read any of them.

Discovery is key-based, not a per-user registry:

- The blind peer is reachable on the DHT by **its own public key** — one static value per node, the same for every user, shipped to wallets in app/BE config. It is **not** per-user.
- A user's book is located by its **seed-derived autobase key**, which every one of that user's devices computes locally.
- A device asks the peer to mirror its book via `addMirror(mirrorKey)` (a `blind-peering` RPC under the hood). The peer then replicates that user's cores.
- A restoring device connects to the **same static** `mirrorKey` and pulls the user's data using the derived autobase key.

So what you distribute to wallets is a fixed set of blind-peer public keys (like DHT bootstrap nodes), not anything per user. The per-user value — the autobase key — is derived from the seed and never needs distributing.

## Example: running a blind peer

Run one with the [`blind-peer`](https://github.com/holepunchto/blind-peer) package (or `blind-peer-cli` for a ready-made CLI). One node serves many users:

```js
import BlindPeer from 'blind-peer'
import idEnc from 'hypercore-id-encoding'

// Persists which cores it mirrors; reachable on the DHT by its keypair.
const peer = new BlindPeer('./blind-peer-storage')
await peer.ready()
await peer.listen()

// Static public key — put it in app/BE config; the same key serves every user.
// Clients use it via addMirror(key) and AddressBook.open(store, { ..., mirrors: [key] }).
console.log('blind peer key:', idEnc.encode(peer.publicKey))
```

Pass `{ bootstrap }` to target a specific DHT (e.g. a testnet); omit it for the public DHT. For capacity, run several blind peers and ship the list — clients mirror to the closest by key.
