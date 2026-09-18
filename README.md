# ORYH AI Client

The AI client for ORYH: Host plugins, Client plugins and the `oryh-web` Profile, running on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The window has three columns: the business menu on the left, the ordinary business pages in the middle,
and Chat on the right. Harness provides the startup, the authentication, the sessions, the model settings
and the plugin lifecycle; the plugins here provide the ORYH enterprise connection, the business lists and
the forms — one Host plugin and one Client plugin per business domain, with a pane bridge that ties Chat
to whatever the middle column is showing.

## What it does

- **To-dos**: the ones assigned to you, and the documents behind them.
- **Timesheets**: query, create, edit and submit; managers approve.
- **Expenses**: locally encrypted drafts, a check before sending, create and submit.
- **Projects**: query and create.
- **Sales orders, inventory, shipments**: query and filter, and keep a filter as a menu entry of your own.
- **Chat**: the agent reads and writes business data through ORYH's MCP and skills, and can open the pages
  and forms in the middle column. Whether a write needs confirmation first is decided by the skills ORYH
  serves, not by this client.

Credentials stay on the Host side and in the system keychain; the browser reaches business services
through generated, typed Remote calls. Every session is pinned to one ORYH tenant and one employee identity.

## Running it with Docker Compose

You need Docker and the two source directories side by side:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout c291e7961a
git clone https://github.com/AIE-enginehub/oryh-ai-client.git
cd oryh-ai-client
```

Harness is pinned to `c291e7961a`: this repository depends on a fix to external-plugin Remote generation
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

You need Node.js 24, pnpm 11, and `deepseek-harness` beside this directory (this repository depends on it
through `link:`). Check Harness out at `c291e7961a` and apply the patch before installing, or the patch
check in `pnpm build` stops the build:

```sh
git -C ../deepseek-harness apply ../oryh-ai-client/patches/deepseek-harness-external-remote.patch
pnpm install
pnpm build      # build the plugins and generate the Remote descriptors
pnpm verify     # lint, typecheck and tests
pnpm start      # start the oryh-web Profile
```

## What is where

| Directory | Contents |
| --- | --- |
| `packages/foundation`, `pages`, `store` | Shared ground: the error type and identifiers, the business page registry, encrypted revisioned storage |
| `packages/core` | The ORYH runtime on the Host side: connection, credentials, deterministic operations, encrypted drafts |
| `packages/workspace` | Enterprise selection and workbench state, without a UI framework |
| `packages/timesheets`, `expenses`, `projects`, `records`, `todos` | Each business domain's operations and checks |
| `packages/host-connection` | Host plugin: the enterprise connection, skills and the MCP client (Remote namespace `oryh`) |
| `packages/host-pane` | Host plugin: the pane bridge — binding a Chat session to the middle column, its page state and the agent's commands |
| `packages/host-todos`, `host-timesheets`, `host-expenses`, `host-projects`, `host-records` | One Host plugin per business domain |
| `packages/host-agent` | The ORYH business agent: system prompt, tools, and ORYH's MCP |
| `packages/client-frame` | The browser frame: the three-column layout, the menu, the connection page, the pane hooks |
| `packages/client-todos`, `client-timesheets`, `client-expenses`, `client-projects`, `client-records` | One Client plugin per business page |
| `packages/dsh-bundle` | The `oryh-web` Profile and the plugin bundle |
| `deploy/local` | The single-user container: its sign-in gateway and model configuration |

## License

[Apache License 2.0](LICENSE).
