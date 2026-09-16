# ORYH Profile bundle

This package contributes the ORYH Host and Client rows through `cordis.patch.yml`. Compose it after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` in `oryh-web`. Use the repository's `profile:install` script and the official `dsh --profile` launcher.

The bundle has no executable or application boot code. Its Host policy admits only the ORYH business tools for each Agent and denies every other tool at `tools/pre-execute`, so the Profile's coding tools stay loaded but unreachable. ORYH traditional operations remain available through authenticated Remote calls, and formal confirmation stays outside model-callable tools. This local-development dependency graph is not an npm release configuration.

Workspace selection uses the official browse directory-picker Host and Client plugins so the dialog stays inside the Web client. The automatic native chooser is disabled by the Bundle patch. Models and credentials continue to use the native Harness settings plugins.
