/** The words a page says, as the frame hands them on: Harness's locale service bound to ORYH's namespace. */
import type { OryhKey } from './dictionary.js'

export type { OryhKey }
export type OryhText = (key: OryhKey, params?: Record<string, unknown>) => string
