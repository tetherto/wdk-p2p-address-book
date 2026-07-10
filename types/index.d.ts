export type AddressType =
  | 'bitcoin'
  | 'evm'
  | 'tron'
  | 'uma'
  | 'lightning-address'
  | 'lnurl'
  | 'spark'

export const ADDRESS_TYPES: Readonly<{
  BITCOIN: 'bitcoin'
  EVM: 'evm'
  TRON: 'tron'
  UMA: 'uma'
  LIGHTNING_ADDRESS: 'lightning-address'
  LNURL: 'lnurl'
  SPARK: 'spark'
}>

export interface Contact {
  id: string
  name: string
  username?: string | null
  createdAt: number
  updatedAt: number
}

export interface Address {
  id: string
  contactId: string
  address: string
  type: AddressType
  network: string
  label: string | null
  createdAt: number
  updatedAt: number
}

export interface Writer {
  key: Uint8Array
  name: string | null
}

export interface Mirror {
  key: Uint8Array
}

/** `Mirror` as received over the worklet bridge — `Uint8Array` auto-normalized to hex. */
export interface MirrorApi {
  key: string
}

export interface AddressBookOptions {
  key?: Uint8Array | null
  keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array } | null
  encryptionKey?: Uint8Array | null
  wakeup?: unknown
  swarm?: unknown
  bootstrap?: unknown
  relayThrough?: unknown
  mirrors?: Array<string | Uint8Array>
  replicate?: boolean
  optimistic?: boolean
}

export interface FromSeedOptions {
  namespace: string
  mirrors?: Array<string | Uint8Array>
  bootstrap?: unknown
  swarm?: unknown
  relayThrough?: unknown
  replicate?: boolean
  name?: string | null
  timeout?: number
}

export interface AddContactInput {
  name: string
  username?: string | null
}

export interface AddAddressInput {
  address: string
  type: AddressType
  network: string
  label?: string | null
}

export interface EditContactInput {
  name?: string
  username?: string | null
}

export interface EditAddressInput {
  address?: string
  type?: AddressType
  network?: string
  label?: string | null
}

export default class AddressBook {
  constructor(corestore: unknown, opts?: AddressBookOptions)

  static fromSeed(seed: Uint8Array, corestore: unknown, opts: FromSeedOptions): Promise<AddressBook>

  static deriveAutobaseKey(
    keyPair: { publicKey: Uint8Array } | Uint8Array,
    opts?: { version?: number }
  ): Uint8Array

  static createWorkletModule(ctx: { seed: Uint8Array; config: FromSeedOptions & { storagePath: string } }): Promise<AddressBook>

  static selectMirrors(autobaseKey: Uint8Array | string, pool: Array<string | Uint8Array>, n?: number): Array<string | Uint8Array>

  readonly writerKey: Uint8Array
  readonly key: Uint8Array
  readonly discoveryKey: Uint8Array
  readonly encryptionKey: Uint8Array | null
  readonly writable: boolean

  ready(): Promise<void>
  close(): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>
  getInfo(): Promise<{ autobaseKey: string; writable: boolean }>
  create(): Promise<void>

  addContact(input: AddContactInput): Promise<Contact>
  editContact(id: string, updates: EditContactInput): Promise<Contact>
  deleteContact(id: string): Promise<void>
  getContact(id: string): Promise<Contact | null>
  listContacts(): Promise<Contact[]>

  addAddress(contactId: string, input: AddAddressInput): Promise<Address>
  editAddress(id: string, updates: EditAddressInput): Promise<Address>
  deleteAddress(id: string): Promise<void>
  listAddresses(contactId?: string): Promise<Address[]>
  search(query: string): Promise<Contact[]>

  on(event: 'update', listener: () => void): this
  off(event: 'update', listener: () => void): this

  addWriter(data: Uint8Array | string | Writer): Promise<void>
  removeWriter(key: Uint8Array | string): Promise<void>
  listWriters(query?: Partial<Writer>): unknown
  getWriter(key: Uint8Array): Promise<Writer | null>

  addMirror(key: string | Uint8Array): Promise<Array<string | Uint8Array>>
  addMirror(pool: Array<string | Uint8Array>, n?: number): Promise<Array<string | Uint8Array>>
  listMirrors(): Promise<Mirror[]>
  removeMirror(key: string): Promise<void>
}

/**
 * Host-side (app) API of the address book module, as called over the worklet module
 * bridge — e.g. `useModule<AddressBookApi>('addressBook')`. Every method is async and
 * takes/returns JSON-serializable values. Inputs are hex/z-base32 strings; returned
 * `Uint8Array` values are auto-normalized to hex by the RPC layer. The `'update'` event
 * is delivered via the module proxy's `on('update', ...)`, not here.
 */
export interface AddressBookApi {
  getInfo(): Promise<{ autobaseKey: string; writable: boolean }>
  create(): Promise<void>

  addContact(input: AddContactInput): Promise<Contact>
  editContact(id: string, updates: EditContactInput): Promise<Contact>
  deleteContact(id: string): Promise<void>
  getContact(id: string): Promise<Contact | null>
  listContacts(): Promise<Contact[]>

  addAddress(contactId: string, input: AddAddressInput): Promise<Address>
  editAddress(id: string, updates: EditAddressInput): Promise<Address>
  deleteAddress(id: string): Promise<void>
  listAddresses(contactId?: string): Promise<Address[]>
  search(query: string): Promise<Contact[]>

  addMirror(key: string): Promise<string[]>
  addMirror(pool: string[], n?: number): Promise<string[]>
  listMirrors(): Promise<MirrorApi[]>
  removeMirror(key: string): Promise<void>
}

export { AddressBook }
