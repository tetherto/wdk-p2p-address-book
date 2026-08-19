# @tetherto/wdk-p2p-address-book

Encrypted, multi-device contact/address book built on Autobase. All keys are derived from the wallet seed, data syncs peer-to-peer (and via always-on blind peers), and the backend only ever sees opaque encrypted blocks.

ESM, Node + Bare compatible.

## Install

```
npm install @tetherto/wdk-p2p-address-book
```

## Example: from a seed to an address book

`AddressBook.fromSeed` derives the book's keys (HKDF) from a wallet seed and `namespace`, then opens any state already stored in the supplied `Corestore`. It deliberately does not guess whether an unenrolled device should create a new book or join an existing one: a new or restoring device starts read-only and must choose an enrollment path explicitly.

```js
import Corestore from 'corestore'
import AddressBook from '@tetherto/wdk-p2p-address-book'

// `seed` is the BIP-39 seed BYTES (not the mnemonic string).
// Pass your own Corestore; share a namespaced one if you run other WDK modules,
// e.g. appStore.namespace('address-book').
const store = new Corestore('./addressbook')

// `namespace` scopes the derived book to your app (required). Two apps using the
// same seed but different namespaces get completely separate address books.
const book = await AddressBook.fromSeed(seed, store, { namespace: 'tether-wallet' })

// This user has no existing address book, so establish its genesis and enroll
// this device's writer. Do not call create() when restoring an existing book.
await book.create()

// `mirrorKey` is a blind peer's public key (see "How sync works" below) — one
// static value, the same for every user, shipped in app/BE config. Registering it
// asks the peer to mirror THIS user's book. `addMirror` resolves with the mirror
// key(s) selected, as given — an array, most useful when passing a pool.
await book.addMirror(mirrorKey)
await book.addContact({ name: 'Alice' })
```

On another device, pass the blind peer key as `mirrors` so replication can start as the book opens, then call `addMirror()` to sync the existing book and enroll this device's writer:

```js
const store = new Corestore('./addressbook')
const restored = await AddressBook.fromSeed(seed, store, {
  namespace: 'tether-wallet',
  mirrors: [mirrorKey]
})
await restored.addMirror(mirrorKey)
await restored.addContact({ name: 'Bob' })
```

The three opening cases are:

- **Brand-new book:** `fromSeed()` returns read-only; call `create()` once, then optionally `addMirror()`.
- **Restore on another device:** `fromSeed()` returns read-only; call `addMirror()` to sync and join the existing book. Do not call `create()`, because that would start a fresh history instead of restoring.
- **Reopen on the same device:** if its enrolled writer is present in the same persistent `Corestore`, `fromSeed()` reopens writable and no enrollment call is needed.

The same seed and namespace always derive the same address book (its autobase key is deterministic), so every device converges on one book. Internally, a per-seed bootstrap keypair seeds the genesis and authorizes each device's own writer — it is never a long-lived writer. Conflicts resolve last-write-wins.

The `namespace` is required and scopes everything: it is mixed into key derivation (per-app book identity) and used to namespace the cores within the `Corestore`, so two different namespaces can safely share one store without colliding. The seed is the per-user secret, and the blind-peer key(s) are the only shared config. You own the `Corestore` lifecycle and call `close()` on it yourself.

> Note: on a read-only device, `addMirror()` is join-only: it waits up to `opts.timeout` (default 20s) for an existing genesis and throws if none can be synced. It never silently creates a new book. Call `create()` first only when you know this user has no existing book; once the book is writable, `addMirror()` registers the mirror normally.

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
// Clients use it via addMirror(key) and AddressBook.fromSeed(seed, store, { namespace, mirrors: [key] }).
console.log('blind peer key:', idEnc.encode(peer.publicKey))
```

Pass `{ bootstrap }` to target a specific DHT (e.g. a testnet); omit it for the public DHT. For capacity, run several blind peers and ship the list — clients mirror to the closest by key.
