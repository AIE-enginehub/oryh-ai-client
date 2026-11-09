/**
 * Menu entries colleagues share with each other (docs/58).
 *
 * A person's own entries live in their workspace, on their disk. Sharing one hands how it is made — the
 * collection, the narrowing, the columns — to the deployment's library, where every colleague of the same
 * enterprise reads it; nothing it showed goes with it, and whoever opens it reads ORYH as themselves. A
 * shared entry stays its author's: colleagues open it or take a copy, and only the author changes or
 * withdraws it. Where the deployment keeps no library — the desktop — none of this is offered.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { OryhClientError } from '@oryh/ai-client-foundation'
import type { OryhLibrary, SharedEntry } from '@oryh/dsh-connection'
import type { PaneService } from './service.js'
import type { UserViewSummary } from './types.js'
import { readSharedView } from './user-views.js'

const fail = (text: string) => new OryhClientError(text, 'request-failed')
/** The collection a custom page's menu entry names: a page is shared as a page, not as a list. */
const CUSTOM_PAGES = 'custom-pages'

/**
 * What the plugin that owns custom pages does for sharing them. The menu is the pane's; a page's definition
 * is its plugin's, so sharing one asks for it and copying one hands it back.
 */
export interface SharedPages {
  /**
   * How one of the person's own pages is made, to hand to colleagues.
   * @throws when the page is not theirs — none of that id, or one a colleague shared.
   */
  definition(sessionId: string, pageId: string): Promise<{ title: string; body: unknown }>
  /** Make a page of the person's own from one a colleague shared; `entry` carries its definition. */
  copy(sessionId: string, entry: SharedEntry): Promise<{ id: string; label: string }>
}

/** What a copy came to: an entry in the person's menu, or a page of theirs that enters the menu once it has run. */
export interface CopiedView {
  kind: SharedEntry['kind']
  id: string
  label: string
}

export class SharedViews {
  /** What the library last said, until a colleague changes it. */
  #entries: SharedEntry[] | undefined
  #loading: Promise<SharedEntry[]> | undefined
  /** When to ask again a library that could not be read; 0 while there is nothing to make up for. */
  #retryAt = 0
  #revision = 0
  #pages: SharedPages | undefined
  /** Share, update and withdraw run one at a time: each reads the library before it writes it. */
  #mutations: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly pane: PaneService,
  ) {}

  private get library(): OryhLibrary | undefined {
    return this.ctx.get('oryhLibrary')
  }

  /**
   * Let custom pages be shared: called by the plugin that owns them.
   * @returns takes it off again.
   */
  providePages(pages: SharedPages): () => void {
    this.#pages = pages
    return () => {
      if (this.#pages === pages) this.#pages = undefined
    }
  }

  /** Publish with the rest of the pane's state, and follow what colleagues do. */
  install(): void {
    this.ctx.effect(
      () =>
        this.pane.provideState(() => {
          if (!this.library) return {}
          const entries = this.entries()
          return entries
            ? { sharedViews: viewsOf(entries), sharedOwn: entries.filter(e => e.mine).map(e => e.id) }
            : { sharedPending: true as const }
        }),
      'oryh shared views state',
    )
    // A person with no session open sees what colleagues share all the same: it does not depend on one.
    this.ctx.effect(
      () => this.pane.provideMenu(async () => (this.library ? viewsOf(this.#entries ?? (await this.reload())) : [])),
      'oryh shared views menu',
    )
    this.ctx.inject(['oryhLibrary'], inner => {
      inner.effect(
        () =>
          this.library?.onChanged(() => {
            void this.reload()
          }) ?? (() => {}),
        'oryh shared views follow',
      )
    })
  }

  /** What colleagues share, if it has been read; read in the background the first time anyone asks. */
  private entries(): SharedEntry[] | undefined {
    const due = this.#retryAt !== 0 && Date.now() >= this.#retryAt
    if ((this.#entries === undefined || due) && !this.#loading) void this.reload()
    return this.#entries
  }

  /** Read the library again and tell every page. A library that cannot be read leaves what was known. */
  private reload(): Promise<SharedEntry[]> {
    const library = this.library
    if (!library) return Promise.resolve([])
    // Menu entries with how each is made, pages by name only: a page's definition is brought when it is opened.
    const revision = ++this.#revision
    const loading = Promise.all([library.list('menu'), library.list('page')])
      .then(lists => lists.flat())
      .then(
        entries => {
          if (revision !== this.#revision) return this.#entries ?? []
          if (this.#loading === loading) this.#loading = undefined
          this.#retryAt = 0
          const changed = JSON.stringify(entries) !== JSON.stringify(this.#entries)
          this.#entries = entries
          if (changed) this.pane.changedEverywhere()
          return entries
        },
        () => {
          if (revision !== this.#revision) return this.#entries ?? []
          if (this.#loading === loading) this.#loading = undefined
          // A library that cannot be read is no reason to hold the person's whole menu back: nothing is
          // shown as shared until it answers. It is asked again the next time a page is told anything,
          // half a minute on at the earliest, and whenever a colleague changes it.
          this.#retryAt = Date.now() + 30_000
          if (this.#entries === undefined) {
            this.#entries = []
            this.pane.changedEverywhere()
          }
          return this.#entries
        },
      )
    this.#loading = loading
    return loading
  }

  /** The entries colleagues shared, as this session's menu shows them; empty until read, or without a library. */
  views(): UserViewSummary[] {
    return this.library ? viewsOf(this.entries() ?? []) : []
  }

  /** Which of the person's own entries they share now. */
  own(): string[] {
    return this.library ? (this.entries() ?? []).filter(e => e.mine).map(e => e.id) : []
  }

  /** A colleague's shared entry of this id, if the library is known to have one. */
  entry(id: string): SharedEntry | undefined {
    return this.library ? (this.entries() ?? []).find(e => e.id === id && !e.mine) : undefined
  }

  /**
   * Share one of the person's own entries with their colleagues, or stop sharing it.
   * @param sessionId - the bound session, whose workspace holds the entry.
   * @param userViewId - the person's own entry: a list they had made, or a custom page.
   * @param shared - whether colleagues should see it from now on.
   * @returns what was done, for whoever asked to tell the person.
   */
  async share(sessionId: string, userViewId: string, shared: boolean): Promise<string> {
    return this.#serial(() => this.#share(sessionId, userViewId, shared))
  }

  /** The body of {@link share}, queued with the other library mutations. */
  async #share(sessionId: string, userViewId: string, shared: boolean): Promise<string> {
    const library = this.library
    if (!library) throw fail('当前部署没有共享库，菜单项和页面只能自己用。')
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    if (this.entry(userViewId)) throw fail('这是同事共享的，只有共享的人可以更改共享。')
    const view = (await this.pane.refreshMenu(sessionId)).find(v => v.id === userViewId)
    // A page enters the menu only once it has run; one that has not is still the person's to share.
    const page = view ? view.collection === CUSTOM_PAGES : this.#pages !== undefined
    if (!view && !page) throw fail('没有这个菜单项，请先读取当前页面的 userMenu。')
    if (page) {
      if (!this.#pages) throw fail('当前环境没有自定义页面。')
      const made = await this.#pages.definition(sessionId, userViewId)
      if (!shared) return this.withdraw(library, 'page', userViewId, made.title)
      await library.put({ kind: 'page', id: userViewId, title: made.title, body: made.body })
      await this.reload()
      return `已把页面“${made.title}”共享给本企业的同事：他们的菜单里会出现它，打开时各自按自己的 ORYH 权限读数据、各自刷新。只共享了页面的做法，没有共享任何数据；你之后改这个页面，他们看到的也跟着变。`
    }
    if (!shared) return this.withdraw(library, 'menu', view!.id, view!.label)
    await library.put({
      kind: 'menu',
      id: view!.id,
      title: view!.label,
      body: {
        collection: view!.collection,
        filters: view!.filters,
        ...(view!.display ? { display: view!.display } : {}),
      },
    })
    await this.reload()
    return `已把“${view!.label}”共享给本企业的同事：他们的菜单里会出现它，打开时各自按自己的 ORYH 权限读数据。只共享了菜单的做法（集合、筛选条件、显示列），没有共享任何数据。`
  }

  private async withdraw(library: OryhLibrary, kind: SharedEntry['kind'], id: string, title: string): Promise<string> {
    let removed: boolean
    try {
      removed = await library.remove(kind, id)
    } catch {
      throw fail('共享库暂时不可用，尚未取消共享，请稍后重试。')
    }
    await this.reload()
    return removed
      ? `已取消共享“${title}”，同事的菜单里不再有它；他们已经复制的不受影响。`
      : `“${title}”本来就没有共享。`
  }

  /**
   * Say again what the person shares of something they just changed, so colleagues get the change.
   * Nothing is done for what they do not share.
   * @param item - the entry or page as it is now.
   */
  async update(item: { kind: SharedEntry['kind']; id: string; title: string; body: unknown }): Promise<void> {
    return this.#serial(async () => {
      const library = this.library
      if (!library) return
      const entry = await library.get(item.kind, item.id)
      if (!entry?.mine) return
      await library.put(item)
      await this.reload()
    })
  }

  /**
   * The person removed one of their own entries or pages: what they shared of it goes too, or it would
   * stay in colleagues' menus with nobody left who could withdraw it.
   * @param id - what is being removed.
   * @param kind - the library namespace owned by the caller.
   * @returns whether a shared entry was withdrawn. Failures leave local deletion to be retried.
   */
  async forget(id: string, kind: SharedEntry['kind']): Promise<boolean> {
    return this.#serial(async () => {
      const library = this.library
      if (!library) return false
      // Cache contents are presentation only; an unloaded or failed menu cannot hide a shared entry.
      let entry: SharedEntry | undefined
      try {
        entry = await library.get(kind, id)
      } catch {
        throw fail('共享库暂时不可用，已保留本地内容，请稍后重试删除。')
      }
      if (!entry) return false
      if (!entry.mine) throw fail('只有共享的人可以取消共享。')
      let removed: boolean
      try {
        removed = await library.remove(kind, id)
      } catch {
        throw fail('共享库暂时不可用，尚未取消共享，已保留本地内容，请稍后重试删除。')
      }
      await this.reload()
      return removed
    })
  }

  /** Queue one library mutation behind the ones before it, whether they succeeded or failed. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#mutations.then(work, work)
    this.#mutations = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Take a copy of what a colleague shared: an entry into the person's own menu, a page into their own pages.
   * @param sessionId - the bound session, whose workspace the copy goes into.
   * @param sharedViewId - the colleague's entry.
   * @returns the copy, which is the person's own from here on.
   */
  async copy(sessionId: string, sharedViewId: string): Promise<CopiedView> {
    const library = this.library
    if (!library) throw fail('当前部署没有共享库。')
    const home = this.pane.session(sessionId)
    if (!home) throw fail('请先在 Chat 中选择会话并等待已关联。')
    const gone = '这个共享的内容已经不在了，可能是共享的人取消了共享。'
    // What the menu last heard says which kind it is; before the menu has been read, the library is asked for both.
    const known = this.entry(sharedViewId)?.kind
    const entry = known
      ? await library.get(known, sharedViewId)
      : ((await library.get('menu', sharedViewId)) ?? (await library.get('page', sharedViewId)))
    if (!entry || entry.mine) throw fail(gone)
    const kind = entry.kind
    if (kind === 'page') {
      if (!this.#pages) throw fail('当前环境没有自定义页面。')
      return { kind, ...(await this.#pages.copy(sessionId, entry)) }
    }
    const made = readSharedView(entry.body)
    if (!made) throw fail(gone)
    const own = await this.pane.refreshMenu(sessionId)
    // The person's own names are unique; a copy that would clash says whose it was.
    const taken = new Set(own.map(v => v.label))
    const label = [entry.title, `${entry.title}（${entry.author}）`.slice(0, 24)].find(name => !taken.has(name))
    if (!label) throw fail(`你的菜单里已经有“${entry.title}”，请先改名或删除再复制。`)
    const copy: UserViewSummary = { id: randomUUID(), label, ...made }
    this.pane.setMenu(sessionId, await this.pane.userViews.add(sessionId, home.scope, copy))
    return { kind, id: copy.id, label }
  }
}

/** Colleagues' entries as menu entries: the asker's own are in their menu already, and are left out. */
function viewsOf(entries: readonly SharedEntry[]): UserViewSummary[] {
  return entries.flatMap(entry => {
    if (entry.mine) return []
    const shared = { id: entry.id, label: entry.title.slice(0, 24), origin: 'shared' as const, sharedBy: entry.author }
    // A page is named here and read when it is opened, by the plugin that draws it.
    if (entry.kind === 'page') return [{ ...shared, collection: CUSTOM_PAGES, filters: {} }]
    const made = readSharedView(entry.body)
    // One this version cannot read is left out of this person's menu, and stays in the library as it is.
    return made ? [{ ...shared, ...made }] : []
  })
}
