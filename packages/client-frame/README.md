# ORYH Client frame

This directory publishes `@oryh/dsh-client-frame`, with a Host loader entry, browser `./client` module and `dsh.client` dependency manifest. There is no standalone page or HTTP server. The business pages are separate page plugins (`packages/client-*`): each mounts its own Remote namespace, registers its menu entry through `ctx.oryhClientPages`, and injects its page into the `oryh.page` keyed slot this frame declares (and, when it handles the agent's commands for its pages, a component into the `oryh.bridge` list slot). Page plugins share this frame's one browser bundle through `dsh.client.external`, so the React contexts and the Fluent provider are the same instances everywhere; its `./client` export is the kit they build on.

The ORYH Bundle disables the default layout. This plugin provides the sole `root` and public `ctx.layout` service: business navigation and the native sidebar on the left, root-scoped `oryh.business` in the center, and the native session-maybe `conversation` on the right. Native `rightbar` remains a session-scoped overlay; `shell.overlay` is retained. No private Harness source or conversation component is imported.

Root geometry uses a Harness `defineStore`. Business pages remain mounted across navigation and chat visibility changes, independently of Session selection. Narrow screens switch between business and chat. Saved drafts remain encrypted on the Host; refresh and unload clear unsaved edits.

Generated Remote descriptors mount through the public Gateway and wait for `remote.oryh`. Business components receive that transport; each page plugin mounts its own domain namespace beside it. Locale, theme, styles and slot registrations are lifecycle-owned, and Fluent portals mount under the business root.

The current upstream renderer has a root-gap error during development hot replacement. The Profile disables `client-hmr`; save drafts, stop the server, build and restart when upgrading. Normal plugin unload/re-register is covered by public SlotCore/Cordis lifecycle tests.

The native conversation is the only chat. Chat-driven navigation, list columns, inventory query fields and form filling are enabled: this package syncs the current page, its list or detail context and unsaved form fields to the Host through the generated Remote, and applies the commands the Host issues, acknowledging each with the command id so the waiting tool can confirm the page actually changed. Saving, submitting and approving still require the user to confirm in the page. See [migration](../../docs/14-dsh-plugin-migration.md).
