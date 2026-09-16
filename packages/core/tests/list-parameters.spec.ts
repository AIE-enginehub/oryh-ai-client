import { describe, it, expect, vi } from 'vitest'
import { ListParameters, parameters } from '../src/list-parameters.js'

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
