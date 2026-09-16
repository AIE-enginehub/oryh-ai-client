# ORYH Host plugin

Install through `@oryh/dsh-bundle` in the ORYH Profile. Requires public Cordis, Typert and Tools services. Configuration requires `developmentOnly: true`; `dataDirectory` is optional and must be absolute.

The plugin owns ORYH credentials, connection identity verification and encrypted draft persistence. It registers a browser-only `oryh` Remote namespace. Public wire types are exported through `./types`; build-generated descriptors use `./typert` and `./remote`. Errors cross Gateway as `oryh/business` with a safe message and domain code.

No Remote method is a model tool. Model access goes through sixteen separately registered tools covering the current page, navigation, visible todos and their details, timesheet read and suggestions, project form read and fill, and list column and query-field configuration. Each Agent receives an allowlist restricted to exactly those names, and `tools/pre-execute` denies everything else, so the Profile's coding tools stay unreachable. Confirmation tokens reach no tool: prepare and confirm remain browser-only.

Page commands carry a receipt: a tool resolves only when the browser syncs back state matching the command it issued, and `CommandQueue` settles those waits on each page or form sync rather than polling. Unloading removes the tool restrictions, fails pending command waits, stops new Remote work, aborts in-flight HTTP and drains entered requests without deleting credentials. Aborting transport does not undo a server write; expense reconciliation remains necessary.

The profile is single-user and local. Tenant-bound AI Sessions, business chat tools and shared hosted deployment are not supported. The local public-package links require the documented Harness compatibility patch. See [migration](../../docs/14-dsh-plugin-migration.md) for validation and limits.
