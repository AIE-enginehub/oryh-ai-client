// Page access policy lives in @oryh/ai-client-pages, including the throwing guards: they
// raise OryhClientError, which sank to @oryh/ai-client-foundation, so keeping them here no
// longer avoids a cycle. Re-exported so every existing import keeps working unchanged.
export type { PageId as AccessPage } from '@oryh/ai-client-pages'
export { canAccessPage, hasPermission, requirePage, requirePermission } from '@oryh/ai-client-pages'
