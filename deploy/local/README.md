# The local Compose container

This is the container entry point for the complete **single-user** ORYH client. It runs the native
DeepSeek Harness web Profile with the ORYH plugins. It is not the multi-user server: do not use it to
judge tenant isolation, and do not open it to the internet.

## Starting it

The two source directories must sit side by side: `deepseek-harness/` and `oryh-ai-client/`. From
`oryh-ai-client/`:

```sh
cp .env.example .env   # fill in the ORYH server and the model settings; see "The model" below
docker compose build --build-arg DSH_CLIENT_COMMIT_HASH="$(git -C ../deepseek-harness rev-parse HEAD)"
docker compose up -d
docker compose logs client
```

## Signing in

Open `http://127.0.0.1:4180/` and you are sent to ORYH to sign in. Sign in with your ORYH account, approve,
and you land in the workbench with the enterprise connection already made — there is no device code to
enter. While the browser cookie lasts, opening the address again takes you straight in.

- **The first ORYH account to sign in is the one this container belongs to.** This is a single-user
  client; another account signing in afterwards is refused, so that nobody inherits the previous person's
  sessions and data. To hand the container to someone else, delete the data volume and start again (below).
- The same account signing in again refreshes that connection's credential rather than adding a second one.
- The ORYH address comes from `ORYH_SERVER_ORIGIN` in `.env`, and points at your ORYH deployment.

How it works: the only thing listening outside the container is the sign-in gateway,
[`login-gateway.mjs`](login-gateway.mjs). It signs in through ORYH's OAuth 2.1 authorization code flow with
PKCE, with the loopback address `http://127.0.0.1:4180/oryh/callback` as its redirect. On success it
exchanges the DSH startup token — which only it can read — for DSH's own session cookie, and hands the same
credential to the client as a file with mode 0600 (`ORYH_CREDENTIAL_HANDOFF`; the client deletes it as soon
as it has read it, and keeps the credential in the Linux Secret Service). Everything else is passed through
to Harness on `127.0.0.1:4174` inside the container, with the Host, Origin and cookie checks unchanged. The
startup token is never printed to the log.

## The model

The model belongs to the deployment and is shared by everyone using it: the browser has no model settings
page, and no per-session model switch. Copy `.env.example` to `.env` in `oryh-ai-client/` and fill in:

| Variable | Meaning |
| --- | --- |
| `ORYH_SERVER_ORIGIN` | The ORYH server to sign in to (required) |
| `ORYH_MODEL_API_KEY` | The model API key (required; `docker compose up` fails without it) |
| `ORYH_MODEL_BASE_URL` | The model endpoint; defaults to `https://api.deepseek.com` |
| `ORYH_MODEL` | The model id; defaults to `deepseek-v4-flash` |
| `ORYH_MODEL_REASONING_EFFORT` | `off` / `low` / `high` / `max`; defaults to `high` |

Run `docker compose up -d` again to apply a change. The key reaches Harness as the container's
`DEEPSEEK_API_KEY`: it takes precedence over anything saved in a page, is read-only, and is not passed into
the shell an agent runs. `.env` is neither committed nor built into the image. At every start,
[`model-config.mjs`](model-config.mjs) writes the Profile patch and clears any older model settings in the
user layer, so the deployment's configuration is the one in force.

Chat's workspace is `/home/node/workspace` inside the container. Credentials and files on the host machine
are not copied in.

## Data and lifecycle

- The `client-data` named volume holds the Profile, the model configuration, sessions, the workspace and
  business drafts.
- ORYH credentials and the draft encryption key are kept by the Linux Secret Service inside the container.
  Its unlock password is generated at random into a private file on that volume, with mode 0600. This is a
  single-user deployment that trusts one UID; it is not the server's multi-user isolation.
- `docker compose stop` stops it; `docker compose up -d` starts it again. A plain `docker compose down`
  keeps the data.
- **Do not run `docker compose down -v` unless you mean to delete all of the above for good.**
- After updating the sources, build and start again. Neither an ORYH password nor the model API key is
  stored in the image.

## What this container cannot vouch for

Docker Desktop's kernel does not implement Landlock: the probe returns `ENOSYS`. So this container is not
evidence about Chat's sandboxed script execution, even though the image carries Harness's native Linux
sandbox — no security policy was turned off, nothing runs with Full Access, and the container is not
privileged. The business pages and the enterprise connection can be exercised here; the model configuration
and anything that needs script execution have to be checked separately. A healthy page is not a working
Chat.
