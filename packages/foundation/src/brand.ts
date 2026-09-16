declare const ORYH_ID: unique symbol

/** Create an opaque identifier that cannot be mixed with another identifier type. */
export type Brand<Value, Name extends string> = Value & {
  readonly [ORYH_ID]: Name
}

/** Identifier for one locally configured ORYH connection. */
export type ConnectionId = Brand<string, 'ConnectionId'>

/** Identifier for a cached deterministic operation result. */
export type OperationResultId = Brand<string, 'OperationResultId'>

/** Identifier for one pending Host-side ORYH device authorization. */
export type DeviceAuthorizationId = Brand<string, 'DeviceAuthorizationId'>

/** Identifier for one tenant-bound deterministic operation saved by the user. */
export type SavedOperationId = Brand<string, 'SavedOperationId'>

/** Construct a connection identifier at the Host-owned creation point. */
export function connectionId(value: string): ConnectionId {
  return value as ConnectionId
}

/** Construct an operation result identifier at the Host-owned creation point. */
export function operationResultId(value: string): OperationResultId {
  return value as OperationResultId
}

/** Construct a pending device authorization identifier at its Host-owned creation point. */
export function deviceAuthorizationId(value: string): DeviceAuthorizationId {
  return value as DeviceAuthorizationId
}

/** Construct a saved-operation identifier at its Host-owned creation point. */
export function savedOperationId(value: string): SavedOperationId {
  return value as SavedOperationId
}
