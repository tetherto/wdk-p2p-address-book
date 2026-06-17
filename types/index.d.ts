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

export interface AddContactInput {
  name: string
}

export interface AddAddressInput {
  address: string
  type: AddressType
  network: string
  label?: string | null
}

export interface EditContactInput {
  name?: string
}

export interface EditAddressInput {
  address?: string
  type?: AddressType
  network?: string
  label?: string | null
}

export interface EnrollLocalWriterOptions {
  keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  name?: string | null
  timeout?: number
}

export default class AddressBook {
  constructor(corestore: unknown, opts?: AddressBookOptions)

  static create(
    corestore: unknown,
    opts: AddressBookOptions & { name?: string | null; timeout?: number }
  ): Promise<AddressBook>

  static open(
    corestore: unknown,
    opts: AddressBookOptions & { key: Uint8Array }
  ): Promise<AddressBook>

  static deriveAutobaseKey(
    keyPair: { publicKey: Uint8Array } | Uint8Array,
    opts?: { version?: number }
  ): Uint8Array

  readonly writerKey: Uint8Array
  readonly key: Uint8Array
  readonly discoveryKey: Uint8Array
  readonly encryptionKey: Uint8Array | null
  readonly writable: boolean

  ready(): Promise<void>
  close(): Promise<void>
  suspend(): Promise<void>
  resume(): Promise<void>

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

  addMirror(key: string): Promise<void>
  listMirrors(): Promise<Mirror[]>
  removeMirror(key: string): Promise<void>

  enrollLocalWriter(options: EnrollLocalWriterOptions): Promise<Writer>
}

export { AddressBook }
