import Hyperschema from 'hyperschema'
import HyperdbBuilder from 'hyperdb/builder'
import Hyperdispatch from 'hyperdispatch'
import { readFileSync, writeFileSync } from 'fs'

// SCHEMA CREATION START //
const addressbook = Hyperschema.from('./spec/schema')
const ns = addressbook.namespace('wdk-addressbook')

ns.register({
  name: 'contact',
  compact: false,
  fields: [
    {
      name: 'id',
      type: 'string',
      required: true
    },
    {
      name: 'name',
      type: 'string',
      required: true
    },
    {
      name: 'createdAt',
      type: 'int',
      required: true
    },
    {
      name: 'updatedAt',
      type: 'int',
      required: true
    }
  ]
})

ns.register({
  name: 'address',
  compact: false,
  fields: [
    {
      name: 'id',
      type: 'string',
      required: true
    },
    {
      name: 'contactId',
      type: 'string',
      required: true
    },
    {
      name: 'address',
      type: 'string',
      required: true
    },
    {
      name: 'type',
      type: 'string',
      required: true
    },
    {
      name: 'network',
      type: 'string',
      required: true
    },
    {
      name: 'label',
      type: 'string'
    },
    {
      name: 'createdAt',
      type: 'int',
      required: true
    },
    {
      name: 'updatedAt',
      type: 'int',
      required: true
    }
  ]
})

ns.register({
  name: 'writer',
  compact: false,
  fields: [
    {
      name: 'key',
      type: 'buffer',
      required: true
    },
    {
      name: 'name',
      type: 'string'
    }
  ]
})

ns.register({
  name: 'del-contact',
  compact: false,
  fields: [
    {
      name: 'id',
      type: 'string',
      required: true
    }
  ]
})

ns.register({
  name: 'del-address',
  compact: false,
  fields: [
    {
      name: 'id',
      type: 'string',
      required: true
    }
  ]
})

ns.register({
  name: 'mirror',
  compact: false,
  fields: [
    {
      name: 'key',
      type: 'fixed32',
      required: true
    }
  ]
})

ns.register({
  name: 'del-mirror',
  compact: false,
  fields: [
    {
      name: 'key',
      type: 'fixed32',
      required: true
    }
  ]
})

Hyperschema.toDisk(addressbook, { esm: true })

const dbTemplate = HyperdbBuilder.from('./spec/schema', './spec/db')
const db = dbTemplate.namespace('wdk-addressbook')

db.collections.register({
  name: 'contacts',
  schema: '@wdk-addressbook/contact',
  key: ['id']
})

db.collections.register({
  name: 'addresses',
  schema: '@wdk-addressbook/address',
  key: ['id']
})

db.indexes.register({
  name: 'addresses-by-contact',
  collection: '@wdk-addressbook/addresses',
  key: ['contactId']
})

db.collections.register({
  name: 'writer',
  schema: '@wdk-addressbook/writer',
  key: ['key']
})

db.collections.register({
  name: 'mirrors',
  schema: '@wdk-addressbook/mirror',
  key: ['key']
})

HyperdbBuilder.toDisk(dbTemplate, { esm: true })
ensureEsmExport(
  './spec/db/index.js',
  'export { versions, collections, indexes, resolveCollection, resolveIndex }'
)

const hyperdispatch = Hyperdispatch.from('./spec/schema', './spec/hyperdispatch')
const dispatch = hyperdispatch.namespace('wdk-addressbook')

dispatch.register({
  name: 'put-contact',
  requestType: '@wdk-addressbook/contact'
})

dispatch.register({
  name: 'del-contact',
  requestType: '@wdk-addressbook/del-contact'
})

dispatch.register({
  name: 'put-address',
  requestType: '@wdk-addressbook/address'
})

dispatch.register({
  name: 'del-address',
  requestType: '@wdk-addressbook/del-address'
})

dispatch.register({
  name: 'add-writer',
  requestType: '@wdk-addressbook/writer'
})

dispatch.register({
  name: 'remove-writer',
  requestType: '@wdk-addressbook/writer'
})

dispatch.register({
  name: 'add-mirror',
  requestType: '@wdk-addressbook/mirror'
})

dispatch.register({
  name: 'del-mirror',
  requestType: '@wdk-addressbook/del-mirror'
})

Hyperdispatch.toDisk(hyperdispatch, { esm: true })

function ensureEsmExport (file, exportLine) {
  const code = readFileSync(file, 'utf-8')
  if (code.includes(exportLine)) return
  writeFileSync(file, `${code.trimEnd()}\n\n${exportLine}\n`, 'utf-8')
}
