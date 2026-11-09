/** Product-owned adaptation of the pinned, generated Electron entry (never upstream source). */
export function adaptDesktopEntry(source) {
  // The official shell has no public product-onboarding switch in 0.2.1. All startup,
  // sign-out and expiry paths share this predicate. ORYH's public frame plugin owns
  // enterprise login; Models continues to own independent optional model credentials.
  const predicate =
    /function needsWelcome\(authentication\) \{\s*return !authentication\.loggedIn && !authentication\.hasApiKey;\s*\}/g
  const replaceOnce = (pattern, replacement, label) => {
    if ([...source.matchAll(pattern)].length !== 1)
      throw new Error(`ORYH desktop: pinned ${label} changed; review the shell adapter before packaging`)
    source = source.replace(pattern, replacement)
  }
  replaceOnce(
    predicate,
    'function needsWelcome(authentication) {\n  return false; // ORYH owns enterprise onboarding; model setup is independent.\n}',
    'welcome predicate',
  )
  // The native shell reads account state before evaluating needsWelcome. With the account Host
  // plugins absent that RPC would fail before the workspace opens. Startup only needs the saved
  // language; keep the official settings read and avoid reading credentials or inventing auth state.
  replaceOnce(
    /const state = await readWelcomeState\(\);/g,
    'const state = { localePreference: await welcomeBackend.readLocalePreference() };',
    'startup account read',
  )
  // No account service is mounted in this product. Do not subscribe to its sign-in/expiry stream
  // (which would otherwise reconnect indefinitely). Host authentication and enterprise login stay
  // in their existing owners; only the product-specific account subscription is omitted.
  replaceOnce(
    /const accountBackend = welcomeBackend\.account;\s*stopAccount = accountBackend\.watch\([\s\S]*?\}, \(enabled\) => \{\s*analyticsEnabled = enabled;\s*\}\);/g,
    '// ORYH does not subscribe to model-platform account state.',
    'account subscription',
  )
  // Pinned shell has no public Profile switch. Reuse its task confirmation and orderly Host shutdown.
  replaceOnce(
    /mainWindow = createMainWindow\(\);/g,
    `app.on('oryh-switch-profile', ({ commit, resolve, reject }) => {
    void quitConfirmation.confirm().then(approved => {
      if (!approved || quitting || shellInstallerOwnsQuit) { resolve(false); return; }
      commit();
      app.relaunch();
      resolve(true);
      finishQuit();
    }).catch(reject);
  });
  mainWindow = createMainWindow();`,
    'profile switch lifecycle',
  )
  return source
}
