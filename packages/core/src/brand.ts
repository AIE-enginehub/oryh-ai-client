// The branded identifiers moved to @oryh/ai-client-foundation. These must be re-exported
// rather than redeclared: the brands key off a `unique symbol`, so a second declaration
// would produce identifier types incompatible with the foundation's.
export type {
  Brand,
  ConnectionId,
  DeviceAuthorizationId,
  OperationResultId,
  SavedOperationId,
} from '@oryh/ai-client-foundation'
export {
  connectionId,
  deviceAuthorizationId,
  operationResultId,
  savedOperationId,
} from '@oryh/ai-client-foundation'
