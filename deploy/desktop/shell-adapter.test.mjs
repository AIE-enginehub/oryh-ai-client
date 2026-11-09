import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { adaptDesktopEntry } from './shell-adapter.mjs'

const upstream = `const app = { on() {} };
function createMainWindow() {}
function needsWelcome(authentication) {
  return !authentication.loggedIn && !authentication.hasApiKey;
}
async function openInitialWindow() {
  const state = await readWelcomeState();
  return { locale: state.localePreference, welcome: needsWelcome(state) };
}
function startAccountWatch() {
  stopAccount?.();
  const accountBackend = welcomeBackend.account;
  stopAccount = accountBackend.watch((state) => {
    previousAccountStatus = state.status;
  }, () => {}, () => {}, (enabled) => {
    analyticsEnabled = enabled;
  });
}
mainWindow = createMainWindow();`
test('fresh install, account expiry and sign-out never require provider login', () => {
  const predicate = runInNewContext(`${adaptDesktopEntry(upstream)}; needsWelcome`)
  for (const loggedIn of [false, true])
    for (const hasApiKey of [false, true]) {
      assert.equal(predicate({ loggedIn, hasApiKey }), false)
    }
})
test('unknown or duplicate upstream startup policies fail packaging rather than silently restoring login', () => {
  assert.throws(() => adaptDesktopEntry('function needsWelcome() { return true; }'), /predicate changed/)
  assert.throws(() => adaptDesktopEntry(`${upstream}\n${upstream}`), /predicate changed/)
})
test('workspace startup reads language without requiring account RPCs or inspecting credentials', async () => {
  let localeReads = 0
  const open = runInNewContext(`${adaptDesktopEntry(upstream)}; openInitialWindow`, {
    readWelcomeState: () => {
      throw new Error('Account RPC must not run')
    },
    welcomeBackend: {
      readLocalePreference: async () => {
        localeReads++
        return 'zh-CN'
      },
    },
  })
  const result = await open()
  assert.equal(result.locale, 'zh-CN')
  assert.equal(result.welcome, false)
  assert.equal(localeReads, 1)
})
test('account stream is never opened when its Host provider is disabled', () => {
  let stopped = 0
  const start = runInNewContext(`${adaptDesktopEntry(upstream)}; startAccountWatch`, {
    stopAccount: () => {
      stopped++
    },
    welcomeBackend: {
      get account() {
        throw new Error('Account subscription must not run')
      },
    },
  })
  start()
  assert.equal(stopped, 1)
})
test('changed or duplicate account startup hooks stop packaging for review', () => {
  const read = 'const state = await readWelcomeState();'
  assert.throws(
    () => adaptDesktopEntry(upstream.replace(read, 'const state = await readOtherState();')),
    /startup account read changed/,
  )
  assert.throws(() => adaptDesktopEntry(`${upstream}\n${read}`), /startup account read changed/)
  assert.throws(
    () => adaptDesktopEntry(upstream.replace('accountBackend.watch(', 'accountBackend.watchOther(')),
    /account subscription changed/,
  )
  assert.throws(
    () => adaptDesktopEntry(`${upstream}\n${upstream.slice(upstream.indexOf('function startAccountWatch'))}`),
    /account subscription changed/,
  )
})
test('preserves the rest of the native shell and never fabricates a stored credential', () => {
  const source = `const token = readCredential();\n${upstream}\nstartHost();`
  const result = adaptDesktopEntry(source)
  assert.ok(result.startsWith('const token = readCredential();'))
  assert.ok(result.endsWith('startHost();'))
})

test('account switch uses official task confirmation, commits only on approval and closes the old Host', async () => {
  for (const approved of [false, true]) {
    let handler
    const calls = []
    runInNewContext(adaptDesktopEntry(upstream.replace('const app = { on() {} };', '')), {
      app: {
        on: (_event, callback) => {
          handler = callback
        },
        relaunch: () => calls.push('relaunch'),
      },
      quitConfirmation: { confirm: async () => approved },
      quitting: false,
      shellInstallerOwnsQuit: false,
      finishQuit: () => calls.push('finishQuit'),
    })
    const result = await new Promise((resolve, reject) =>
      handler({ commit: () => calls.push('commit'), resolve, reject }),
    )
    assert.equal(result, approved)
    assert.deepEqual(calls, approved ? ['commit', 'relaunch', 'finishQuit'] : [])
  }
})
test('unknown native Profile lifecycle stops packaging for review', () => {
  assert.throws(
    () => adaptDesktopEntry(upstream.replace('mainWindow = createMainWindow();', 'createOtherWindow();')),
    /profile switch lifecycle changed/,
  )
})
