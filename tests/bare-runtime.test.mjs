import test from 'brittle'

import AddressBook, { ADDRESS_TYPES } from '../bare.js'

test('bare runtime: exports address book API', (t) => {
  t.ok(AddressBook, 'AddressBook should be exported')
  t.is(typeof AddressBook, 'function')
  t.is(ADDRESS_TYPES.EVM, 'evm')
  t.is(ADDRESS_TYPES.UMA, 'uma')
})
