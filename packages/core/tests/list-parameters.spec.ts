import { describe, expect, it, vi } from 'vitest'
import { fields, ListParameters, parameters } from '../src/list-parameters.js'

/** Trimmed from the real `/openapi.json`: FastAPI spells an optional `str | None` as `anyOf`. */
const spec = {
  paths: {
    '/api/v1/shipments': {
      get: {
        parameters: [
          { name: 'direction', in: 'query', schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
          { name: 'include_deleted', in: 'query', schema: { type: 'boolean', default: false } },
          { name: 'page', in: 'query', schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
          { name: 'size', in: 'query', schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
          { name: 'order_by', in: 'query', schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
          { name: 'X-API-Key', in: 'header', schema: { type: 'string' } },
        ],
      },
    },
  },
}

/** Trimmed from the real `/openapi.json`: the envelope and the row are separate components. */
const rows = {
  paths: {
    '/api/v1/sales-order-items': {
      get: {
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Env' } } } } },
      },
    },
    '/api/v1/nothing': { get: { responses: { '200': { content: { 'text/csv': { schema: {} } } } } } },
  },
  components: {
    schemas: {
      Env: { properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Item' } }, meta: {} } },
      Item: {
        required: ['id', 'quantity'],
        properties: {
          id: { type: 'string', title: 'Id' },
          line_no: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          quantity: { type: 'number' },
          is_gift: { type: 'boolean' },
          custom_fields: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

describe('list fields from the deployment schema', () => {
  it("reads the row's scalar fields, in the order the object declares them", () => {
    expect(fields(rows, '/api/v1/sales-order-items')).toEqual([
      { name: 'id', type: 'string', required: true },
      { name: 'line_no', type: 'integer', required: false },
      { name: 'quantity', type: 'number', required: true },
      { name: 'is_gift', type: 'boolean', required: false },
    ])
  })

  it('says nothing where there is no list of rows to read', () => {
    expect(fields(rows, '/api/v1/nothing')).toEqual([])
    expect(fields(rows, '/api/v1/absent')).toEqual([])
    expect(fields({ paths: { '/x': { get: {} } } }, '/x')).toEqual([])
    expect(fields(null, '/api/v1/sales-order-items')).toEqual([])
  })

  it('refuses a reference that does not name a component of this document', () => {
    const outside = structuredClone(rows) as typeof rows & { components: { schemas: Record<string, unknown> } }
    outside.components.schemas.Env = {
      properties: { data: { type: 'array', items: { $ref: 'https://elsewhere/Item' } } },
    }
    expect(fields(outside, '/api/v1/sales-order-items')).toEqual([])
  })

  it('shares one fetched schema with the parameter lookup', async () => {
    const schema = vi.fn(async () => rows)
    const lookup = new ListParameters({ schema } as never)
    expect((await lookup.fieldsOf('c', '/sales-order-items')).map(f => f.name)).toEqual([
      'id',
      'line_no',
      'quantity',
      'is_gift',
    ])
    await lookup.of('c', '/sales-order-items')
    expect(schema).toHaveBeenCalledTimes(1)
  })
})

describe('list parameters from the deployment schema', () => {
  it('reads declared query parameters and leaves paging, sort and headers to the list itself', () => {
    expect(parameters(spec, '/api/v1/shipments')).toEqual([
      { name: 'direction', type: 'string' },
      { name: 'include_deleted', type: 'boolean' },
    ])
  })

  it('says nothing about a path the deployment does not have', () => {
    expect(parameters(spec, '/api/v1/purchase-requests')).toEqual([])
    expect(parameters({}, '/api/v1/shipments')).toEqual([])
    expect(parameters(null, '/api/v1/shipments')).toEqual([])
  })

  it('prefixes the client path the way the schema spells it, and fetches the schema once per window', async () => {
    const schema = vi.fn(async () => spec)
    const lookup = new ListParameters({ schema } as never)
    expect((await lookup.of('c', '/shipments')).map(p => p.name)).toEqual(['direction', 'include_deleted'])
    await lookup.of('c', '/shipments')
    // 1.4 MB per fetch on a real deployment; it changes only when ORYH is redeployed.
    expect(schema).toHaveBeenCalledTimes(1)
  })
})
