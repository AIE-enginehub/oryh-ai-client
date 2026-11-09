# ORYH Profile bundle

This package contributes the ORYH Host and Client rows through `cordis.patch.yml`. Compose it after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` in `oryh-web`. Use the repository's `profile:install` script and the official `dsh --profile` launcher.

The bundle has no executable or application boot code. Its Host policy gives each Agent the tools the ORYH plugins registered, ORYH's own tools over MCP, the skill tool, the question tool and — where the deployment has a shell — `bash`; every other tool of the Profile stays loaded and is hidden from the Agent and refused if called. The Agent is the primary client: it reads and writes through ORYH's tools, and before a write it lists what it is about to write and asks in the conversation. That is the Agent's instruction, not a gate the Host enforces. Pages reach ORYH through authenticated Remote calls. This local-development dependency graph is not an npm release configuration.

Workspace selection uses the official browse directory-picker Host and Client plugins so the dialog stays inside the Web client. The automatic native chooser is disabled by the Bundle patch. Models and credentials continue to use the native Harness settings plugins.

ORYH enterprise identity and model API credentials are independent. The bundle disables Harness's DeepSeek account UI, account controller, account service and account-backed model provider. Settings offers no DeepSeek Account tab, balance or sign-in card, and Models lists only API providers. The native API credential store, provider editor and model picker remain available; existing API configuration and saved credentials are preserved.
