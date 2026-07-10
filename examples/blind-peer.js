// Runs a blind peer (the always-on mirror) and prints its public key.
//
// The printed key is the static `mirrorKey` you hand to the address-book
// script (and to wallets in real config). One node serves many users and only
// ever stores opaque encrypted blocks.
//
// Usage:
//   node examples/blind-peer.js [storage-path]
//
//   storage-path  where the peer persists which cores it mirrors.
//                 defaults to ./blind-peer-storage
//
// Leave it running while you use the address-book script in another terminal.

import BlindPeer from 'blind-peer'
import idEnc from 'hypercore-id-encoding'

const storagePath = process.argv[2] || './blind-peer-storage'

// Omit `bootstrap` to use the public DHT. To target a local testnet instead,
// pass { bootstrap } here with your testnet's bootstrap nodes.
const peer = new BlindPeer(storagePath)

await peer.ready()
await peer.listen()

const mirrorKey = idEnc.encode(peer.publicKey)

console.log('blind peer running')
console.log('  storage:    ' + storagePath)
console.log('  mirror key: ' + mirrorKey)
console.log('')
console.log('Pass this mirror key to the address-book example:')
console.log('  node examples/address-book.js ./device-a ' + mirrorKey)
console.log('')
console.log('Press Ctrl+C to stop.')

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nshutting down blind peer...')
  await peer.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
