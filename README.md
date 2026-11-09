# ORYH AI Client

The AI client for ORYH: Host plugins, Client plugins and the `oryh-web` Profile, running on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The window has three columns: the business menu on the left, the ordinary business pages in the middle,
and Chat on the right. Harness provides the startup, the authentication, the sessions, the model settings
and the plugin lifecycle; the plugins here provide the ORYH enterprise connection, the to-do page, the pages
and lists a person has the agent make for them, and a pane bridge that ties Chat to whatever the middle
column is showing.

## What it does

- **To-dos**: the one built-in page — the ones assigned to you, and the documents behind them.
- **Pages of your own**: say in Chat what you want to see and the agent makes it a page or a list in your
  menu — a custom page built from DeepSeek Harness components by default, or your own markup in a sandboxed
  frame when you ask for that. A page shows the data of its last run and says what it is doing while it
  refreshes.
- **Forms in the conversation**: ask to record a document and the agent puts a form under its answer, with
  lines you can add and totals that follow what you type; a field that points at another ORYH record is
  chosen from a list or a search dialog, never typed.
- **Chat**: the agent is the primary client. It reads and writes business data through ORYH's MCP and
  skills — timesheets, expenses, projects, orders — and before a write it lists what it is about to write
  and asks. It can read a spreadsheet or text file attached to the conversation.

Timesheet, expense and project pages used to be built in. Those plugins have been removed; the agent
handles that work through ORYH's own tools.

Enterprise credentials stay in Harness’s Host-only credentials service; older keychain logins migrate once. New logins do not access the OS keychain. The browser reaches business services
through generated, typed Remote calls. Every session is pinned to one ORYH tenant and one employee identity.

## Running it with Docker Compose

You need Docker and the two source directories side by side:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout dsh-v0.2.1-rc.4
git clone https://github.com/AIE-enginehub/oryh-ai-client.git
cd oryh-ai-client
```

Harness is pinned to `dsh-v0.2.1-rc.4`: this repository depends on a fix to external-plugin Remote generation
that is not upstream yet (`patches/`). The patch is exported against that commit, and the image build
applies it for you.

Copy `.env.example` to `.env`, fill in the ORYH server address and the model settings, then:

```sh
docker compose build --build-arg DSH_CLIENT_COMMIT_HASH="$(git -C ../deepseek-harness rev-parse HEAD)"
docker compose up -d
```

Open `http://127.0.0.1:4180/`, sign in with your ORYH account and approve, and the workbench opens. This is
a **single-user** client: the first account to sign in is the one this container belongs to. The
[local Compose guide](deploy/local/README.md) has the details, the model settings and the data volume.

## Developing locally

You need Node.js 24 (`.nvmrc` says so; `nvm use` picks it up) and pnpm from `corepack enable`. This
repository depends through `link:` on a `deepseek-harness` checkout beside it, at the commit named in
[`patches/`](patches/README.md), with one patch of ours applied and Harness built. One command prepares it:

```sh
pnpm run harness:setup   # clone Harness if missing; an existing checkout must already be at the pinned commit, otherwise the script stops and prints how to move it
pnpm install
pnpm verify              # build the plugins, generate the Remote descriptors, lint, typecheck and test
pnpm start               # start the oryh-web Profile
```

Harness is not ours, so nothing is committed there: the patch lives in this repository and is applied to
your own checkout. Two things go wrong when the first step is done by hand. Run pnpm inside the Harness
directory rather than with `pnpm -C` from here, because corepack takes the pnpm version from the directory
it runs in and Harness pins a different one. And build Harness after applying the patch, because the
generator this repository calls runs from Harness's build output; the patch check that opens `pnpm build`
stops a build that would run without it.

## What is where

| Directory | Contents |
| --- | --- |
| `packages/foundation`, `pages` | Shared ground: the error type and identifiers, the page registry |
| `packages/core` | The ORYH runtime on the Host side: connection, credentials, the deterministic to-do read |
| `packages/workspace` | Enterprise selection and workbench state, without a UI framework |
| `packages/records`, `todos` | Reading ORYH's collections and to-dos, and the words states are shown in |
| `packages/host-connection` | Host plugin: the enterprise connection, skills and the MCP client (Remote namespace `oryh`) |
| `packages/host-pane` | Host plugin: the pane bridge — binding a Chat session to the middle column, its page state and the agent's commands |
| `packages/host-todos`, `host-records`, `host-analytics` | Host plugins: to-dos; the lists a person makes; custom pages and the form in the conversation |
| `packages/host-agent` | The ORYH business agent: system prompt, tool policy, ORYH's MCP tools, reading attachments |
| `packages/client-frame` | The root layout plugin in the browser: the three-column layout, the menu, the connection page, the pane hooks |
| `packages/client-kit` | A static library bundled into each client plugin: controls on Harness's primitives, the shared pieces of a list page, formatting |
| `packages/client-todos`, `client-records`, `client-analytics` | The page plugins: the to-do page; lists; custom pages and the form in the conversation |
| `packages/dsh-bundle` | The `oryh-web` Profile and the plugin bundle |
| `deploy/local` | The single-user container: its sign-in gateway and model configuration |

## License

[Apache License 2.0](LICENSE).
