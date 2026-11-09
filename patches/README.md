# Our patch to DeepSeek Harness

This repository builds against a DeepSeek Harness (DSH) checkout beside it. DSH is someone else's
repository, and nothing is committed there. Our one change to it is kept here as a patch, and the build
applies it to each person's own DSH checkout.

| File | What it is |
| --- | --- |
| `deepseek-harness-external-remote.patch` | The patch |
| `deepseek-harness-external-remote.json` | The DSH version and commit the patch was exported against, and what the patch check looks for |

## What the change is

Two DSH files change:

- `packages/typert/generator/src/analyzer.ts`: 13 lines added, 1 removed;
- `packages/typert/generator/tests/remote-model.spec.ts`: one regression test added.

### The problem

DSH's Typert analyzer finds a plugin's decorated Remote methods and generates the descriptors the browser
side calls the Host through. It recognized protocol symbols from two places only: packages registered in
the DSH workspace, and ambient declarations in its test fixtures.

Our plugins live outside the DSH repository and import the public protocol package,
`@deepseek-ai/dsh-typert-protocol`, as installed in `node_modules`. That is neither of the two, so their
decorated methods were not analyzed and Remote generation failed.

### What the patch does

The analyzer takes one more step: from the source file that uses the symbol it resolves the public protocol
package, follows aliases, and compares the candidate with that package's named exports. What is recognized
is the symbol itself, not the name a decorator happens to have.

### What was not done

- **Registering the dependency as a workspace package.** A dependency outside the plugin's workspace is not
  in its output graph, and registering it would misstate which package owns the generated artifacts.
- **Writing the Remote descriptors by hand.** That bypasses the strict codecs generated from source, which
  callers of an external plugin rely on.

### What follows

- An installed protocol declaration takes part in Remote analysis without becoming one of the plugin's
  generated artifacts.
- The regression test holds two things: generation succeeds when the protocol package is outside the
  plugin's workspace, and a declaration with exactly the same names from an unrelated package is not
  recognized.
- Workspace and ambient recognition work as before. The runtime protocol and Gateway behavior are unchanged.

## How it is applied

- **Developing locally**: run `pnpm run harness:setup` in this repository. It prepares the DSH checkout
  beside it. A missing checkout is cloned at the pinned commit; an existing one must already be at that
  commit, otherwise the script stops and prints how to move it. Then it applies the patch, installs and
  builds. See the [README](../README.md).
- **Building the image**: `deploy/local/Dockerfile` applies the patch itself.
- **The check**: `pnpm build` opens with `scripts/check-dsh-patch.mjs`, which looks for the fix in the
  generator that actually runs, and fails without it. Patching the DSH source without rebuilding DSH is
  caught too, because the generator runs from DSH's build output.

## After upgrading DSH

The patch is tied to a DSH version: an upgrade moves the code it changes, and has done so twice. In order:

1. Apply the patch in the new DSH checkout with `git apply`; if it no longer fits, use `git apply --3way`
   or make the change by hand from the description above.
2. Export it again:

   ```sh
   git -C ../deepseek-harness diff -- packages/typert/generator/src/analyzer.ts packages/typert/generator/tests/remote-model.spec.ts > patches/deepseek-harness-external-remote.patch
   ```

3. Set `harnessVersion` and `harnessCommit` in `deepseek-harness-external-remote.json` to the new version.
   This is where `pnpm run harness:setup` reads the commit to check out.
4. Set `DSH_CLIENT_COMMIT_HASH` in `deploy/local/Dockerfile` to the new commit.
5. Run `pnpm run harness:setup` to rebuild DSH, then `pnpm verify`.

If DSH fixes this upstream one day, delete this directory's patch, `scripts/check-dsh-patch.mjs` and the
steps that apply the patch in the build.
