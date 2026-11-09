# 代码审核意见（2026-11-09）

只读审核的书面记录。本文不修改业务代码或工程配置。

## 审查基线

| 项 | 值 |
| --- | --- |
| 仓库 | [AIE-enginehub/oryh-ai-client](https://github.com/AIE-enginehub/oryh-ai-client) |
| 分支 | `main`（`origin/HEAD` 指向 `origin/main`） |
| 提交 | [`7b9acee80c30f2e62c42a8fb54f0bfc30208e409`](https://github.com/AIE-enginehub/oryh-ai-client/commit/7b9acee80c30f2e62c42a8fb54f0bfc30208e409) |
| 提交说明 | Sign out from the header, a pane that keeps its place, and English documentation |
| 审核方式 | 阅读该提交的树。未改业务代码，未安装依赖，未跑测试，未访问 ORYH 或模型服务 |

永久链接都指向上述提交，不随后续提交移动。

## 审查范围与技术栈

这是跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的 ORYH 单用户工作台。

- 包管理与工具：pnpm workspace、TypeScript、Vitest、Biome。
- Host 插件：企业连接、凭据、加密草稿、业务写入。
- Client 插件：三栏工作台界面。
- `packages/dsh-bundle`：`oryh-web` Profile。
- `deploy/local`：单用户容器和登录网关。
- 业务域：待办、工时、费用、项目、单据查询，以及通过 ORYH MCP 读写数据的 Chat。

README 要求 Node.js 24、pnpm 11，并把 Harness 固定在 `c291e7961a`，再应用 `patches/`。审核当时的环境是 Node v22.23.4，工作区旁边没有 `deepseek-harness`，也没有 `node_modules`。

仓库内没有 `docs/` 目录。代码里引用的 `docs/14-dsh-plugin-migration.md` 等编号文档不在这棵树中，因此本记录使用日期文件名，而不是编进那套编号。

## 结论边界

下面每条都标了证据状态：

- **已确认**：该提交中的代码会这样执行，或现有测试已经锁住这一行为。
- **待验证**：代码留出了这条路径，但后果取决于 Harness、ORYH 服务端或容器沙箱，本仓库不能单独证实。

不要把待验证项写成已经打穿的漏洞。尤其是：

- 启动令牌能否重复兑换会话，以及 `/?token=` 是否构成可利用的登录绕过，取决于 Harness 的令牌语义。
- MCP 在 401 后再次 POST，是否变成一笔重复业务写入，取决于服务端在返回该 401 之前有没有已经执行。
- 技能清单路径在删除时缺少 `resolveEntry` 已确认。提示注入能否借 bash 改清单并删到技能目录之外，取决于 shell 有没有被沙箱拦住。

## 1. 一份写坏的修订会冻住整个加密目录

**已确认。** 优先级高（可用性：其他草稿也无法继续提交）。

[`packages/store/src/index.ts` 第 72–120 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/store/src/index.ts#L72-L120)：第 72–78 行按最高修订号选文件；第 83–96 行任一文件解密失败就让整个 `list()` 失败；第 105 行 `append()` 必须先 `list()`；第 113–120 行先用 `wx` 创建文件，再写入并 `fsync`。

费用存储是同一逻辑的副本：[`packages/expenses/src/store.ts` 第 79–124 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/store.ts#L79-L124)。

**触发条件。** 进程在 `open(wx)` 成功之后、写完之前退出，留下空文件或半截文件。该文件修订号更高，重启后被当成最新版本，GCM 校验失败。

**影响。** [`packages/core/tests/expenses.spec.ts` 第 317–329 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/tests/expenses.spec.ts#L317-L329) 已经要求损坏的最新版本不能回退，以免把一次中断的确认再执行一遍。这个选择本身成立。溢出的问题是：坏的是草稿 A 时，`Promise.all` 仍会让同目录草稿 B 的保存、确认和核对一起失败。工时和项目走共享 store，费用走自己的副本，三个目录都会这样。

同一类窗口还有两处：

- 密钥锁：[`packages/store/src/index.ts` 第 50–61 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/store/src/index.ts#L50-L61) 在 `.key-initialization` 上 `wx`，只在 `finally` 里删除。进程死在删除之前，下次创建密钥会一直抛文件系统错误。费用副本在 [`packages/expenses/src/store.ts` 第 57–68 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/store.ts#L57-L68)。
- 会话钉住：[`packages/host-pane/src/registry.ts` 第 111–134 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/host-pane/src/registry.ts#L111-L134) 也是先 `wx` 再写。空文件会让该会话以后 `JSON.parse` 失败。

**建议方向。** 坏文件只隔离对应 id，并继续拒绝把该 id 当成可以再次确认；其他 id 照常读写。密钥锁用过期接管或启动时清理残留。两份 store 一起改，并加「一份坏文件不挡住另一份草稿」的测试。不要删掉「损坏最新版本不能回退」的现有测试。

## 2. 登录网关把 DSH 启动令牌继续交给外部请求

**控制缺口已确认。令牌重复使用之后，是再次登录失败，还是可以不经 ORYH 换到会话，待对照 Harness 验证。** 优先级高。

[`deploy/local/login-gateway.mjs` 第 1–10 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/deploy/local/login-gateway.mjs#L1-L10) 写明：DSH 用一次性启动链接登录，这个令牌只应由网关读取。第 72–79 行从子进程输出里捕获一次 `token`，之后不再更新。第 88–98 行只要路径是 `/` 且查询串里带 `token`，就不走登录页，落到第 119–131 行的 `proxy()`，原样转给 `127.0.0.1:4174`。第 285–294 行每次 OAuth 成功都用同一个 `launchToken` 去换 DSH cookie。

由此可以确定的只有：

- 网关没有吃掉外部请求里的 `token` 查询参数，和文件头的设计说明不一致。
- 网关把捕获到的令牌留在内存里，后续每次发会话都复用它，并且 `if (!launchToken)` 使之后日志里的新令牌不会替换它。

**待验证。** 本仓库没有 Harness 源码，不能判断 `c291e7961a` 的启动令牌是一次性的还是进程存活期间可重复兑换。

- 若令牌是一次性的：同一进程里，浏览器 cookie 过期后的第二次 `dshSession` 会失败，直到容器重启。这还不是已经观察到的登录失败。
- 若令牌在进程生命周期内可重复使用：知道令牌的调用方可以请求 `/?token=...`，不经过 ORYH OAuth 拿到 DSH 会话。这还不是已经复现的绕过。

捕获正则是 `[A-Za-z0-9_-]+`（第 73 行）。令牌若含有 `.`、`+` 或 `=`，捕获到的会是前缀，同时整行被替换掉所以不会印出余下部分。令牌字母表同样待 Harness 验证，不能据此断定日志泄漏或登录必然失败。

同一文件第 172 行把回调固定写成 ``http://${host}/oryh/callback``。`ORYH_PUBLIC_HOSTS` 只做字符串白名单（第 22–25 行、第 309–311 行），不要求是回环地址。`compose.yaml` 把端口绑在 `127.0.0.1:4180`，`deploy/local/README.md` 要求不要对公网开放。代码没有强制这条部署约束。端口一旦以明文 HTTP 发布到非回环地址，OAuth 授权码会走该回调。这是部署脚枪，不是已经对公网复现的窃取。

`deploy/local/login-gateway.mjs` 没有测试。

**建议方向。** 反代前去掉 `token` 查询参数。启动令牌的「用完即丢、再次登录另取新链接」要按 Harness `c291e7961a` 的真实语义改，在语义确认前不要假设哪一种失败已经发生。回调协议和 Host 白名单需要与「仅本机」的说明对齐。

## 3. 技能卸载按清单路径删除；容器把密钥解锁口令放在 agent 同一家目录

**删除路径缺少校验已确认。提示注入能否走到删除或读出口令，待验证。** 优先级高（仅当 shell 未被隔离时；沙箱是否生效未在本环境证实）。

[`packages/core/src/skill-bundle.ts` 第 107–115 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/src/skill-bundle.ts#L107-L115) 对服务器给出的新路径做了 `resolveEntry`。第 195–197 行从 `.oryh-manifest.json` 的 `installed` 读旧目录名时只检查是不是字符串。第 268–269 行对不在新清单里的名字直接 `rm(join(this.root, previous), { recursive: true })`。`join` 不会去掉 `..`。相对路径可以落到技能根目录之外。

现有测试只拒绝服务器提供的新名字（同文件测试 `packages/core/tests/skill-bundle.spec.ts` 中 `resolveEntry` / `sync` 的非法名用例），没有覆盖被改过的 `installed`。服务器通过正常 `sync()` 写入的 `installed` 来自已经过校验的技能名，单凭服务端技能名到不了这条删除。

桌面和这只容器打开了 shell：[`packages/host-agent/src/business-agent.ts` 第 26–29 行和第 74 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/host-agent/src/business-agent.ts#L26-L74) 在 `capabilities.shell` 为真时放入 `bash`，并注册 `oryh_skill_sync`（第 137–150 行）。[`packages/host-connection/src/index.ts` 第 75 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/host-connection/src/index.ts#L75) 的桌面能力是 `{ shell: true, writes: true }`。约束 bash 的文字在 [`packages/host-agent/src/prompts.ts` 第 8 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/host-agent/src/prompts.ts#L8)，是提示词，不是隔离。

[`deploy/local/entrypoint.sh` 第 6–12 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/deploy/local/entrypoint.sh#L6-L12) 把 gnome-keyring 解锁口令写到 `$HOME/.config/oryh-container/keyring-password`，与草稿和 Secret Service 数据在同一个 home、同一个 UID。加密草稿的密钥和 ORYH 凭据都在这个 keyring 里。`deploy/local/README.md` 写明 Docker Desktop 上 Landlock 返回 `ENOSYS`，因此这只容器不能当作「Chat 脚本已被沙箱拦住」的证据。

**待验证。** 模型是否能通过 bash 改写清单再调用 `oryh_skill_sync`，以及能否读到解锁口令，取决于 Harness 在 Landlock 不可用时还有没有别的隔离。本审核没有运行容器，没有观察沙箱。

**建议方向。** 删除前对 `installed` 再跑 `resolveEntry`，拒绝 `..`。这是不依赖沙箱的代码修复。解锁口令不要和 agent 同一家目录放在一起，以及容器里是否关闭 `bash`，要等沙箱行为被验证后再定，不要把「提示注入已经能删密钥」写成既成事实。技能安装测试补「篡改清单后 sync」。

## 4. 费用创建遇到 401 后，草稿不能改也不能归档

**已确认。** 优先级高（这张草稿的本地流程卡死）。

[`packages/core/src/http.ts` 第 354–360 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/src/http.ts#L354-L360) 把 HTTP 401 标成 `authentication-failed`。费用确认只把 `code === 'request-failed'` 且为 4xx（排除 408）当成「服务端拒绝」：[`packages/expenses/src/service.ts` 第 327–347 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/service.ts#L327-L347)。401 因此落到 `unknown-create`。

之后 [`expenseSave` 第 136–139 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/service.ts#L136-L139) 只允许覆盖 `editing` 和 `review-create`。[`expenseDelete` 第 432–437 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/service.ts#L432-L437) 也不能归档 `unknown-create`。核对找不到服务端单据时抛「未能唯一定位」，状态仍停在未知。

**触发条件。** 创建 POST 返回 401，包括密钥过期。费用写入设了 `retryExpired: false`，过期也不会在 HTTP 层自动重试。

**影响。** 工时把 401 算进可恢复的拒绝（[`packages/timesheets/src/service.ts` 第 613–616 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/timesheets/src/service.ts#L613-L616)）。项目把 401 标成 `failed`。费用会把一张尚未创建成功的草稿留在列表里，既不能改，也不能清掉。

**建议方向。** 可以确定没有写入时，认证失败回到 `editing`，或允许归档。与工时的 401 分类对齐，并加「401 之后仍能修改草稿」的测试。

## 5. 若干写入把「成功」绑在另一条服务端事实上

**已确认。** 优先级中高（错误地显示已提交，或接下同一员工的另一张单据）。

工时提交的请求体没有意图编号，只有 `{ source: 'web' }`：[`packages/timesheets/src/service.ts` 第 440–443 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/timesheets/src/service.ts#L440-L443)。结果未知时，第 666–669 行只要明细里出现任意一条新的 `action === 'submitted'` 审批记录，就把这次意图标成完成。同一单据上另一次提交（网页端或其他客户端）会让这次超时的操作显示成功。创建和审批使用了意图编号（第 396 行、第 485 行、第 598–599 行），提交没有。

费用创建回执只核对 `id`、`status` 和 `employee_id`：[`packages/expenses/src/service.ts` 第 310–316 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/service.ts#L310-L316)。请求里带了 `oryh_client_draft_id`（第 163 行），`detail()` 也会核对它（第 185–188 行），但成功路径在持久化 `created` 和 `claimId` 之前不核对。同一员工的另一张申请若被当成回执，本地草稿会接上那张申请，后续提交打到那张单据。这里确认的是客户端缺少核对；服务端会不会真的返回另一张单据，没有在本审核中调用 ORYH 验证。

**建议方向。** 提交携带并回读意图编号，核对时只认这一条。创建回执在写入 `created` 之前要求 `oryh_client_draft_id` 一致；对不上就保持未知，不要记下 `claimId`。

## 6. Chat 的 MCP 调用在特定 401 上会再 POST 一次，并把服务端错误文本交给模型

**再 POST 一次已确认。由此造成重复业务写入，待验证，取决于服务端在该 401 之前有没有已经执行。** 优先级中等。

页面写入显式关闭过期重试，例如费用第 305 行、工时第 593 行。[`packages/core/src/http.ts` 第 142–147 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/src/http.ts#L142-L147) 在 `retryExpired !== false`、响应为 401、且 `detail` 包含 `API key expired` 时会再 POST 一次。[`packages/core/src/mcp.ts` 第 233–238 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/src/mcp.ts#L233-L238) 的 `/mcp` POST 没有设 `retryExpired: false`。桌面传输不使用服务端 operation 幂等，见 [`packages/host-agent/src/mcp-tools.ts` 第 122–124 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/host-agent/src/mcp-tools.ts#L122-L124) 的注释。

**触发条件（客户端侧已确认）。** 第一次 MCP POST 的响应是上述 401。客户端会用刷新后的密钥把同一请求体再发一遍。

**待验证。** 若服务端在返回这个 401 之前没有执行写入，第二次是一次正常的重试。只有第一次已经生效时，才会变成重复写入。本审核没有对 ORYH 发请求，不能确认服务端会先提交再返回该 401。

同一文件第 245–248 行把服务端 `error.message` 拼进异常。HTTP 适配器第 354–357 行故意不回显响应正文，理由是代理或服务端可能把凭据带回来。MCP 这条把那段正文交给模型。回显行为已确认；某次真实响应里是否含有凭据，没有样本，不能写成已经泄漏。

第 194–209 行分页只拒绝重复 cursor，没有页数上限。异常或恶意的 MCP 服务端可以让 Host 一直拉。项目列表有 1000 页上限，这里没有。

工具注册是进程级的：[`packages/host-agent/src/mcp-tools.ts` 第 91–99 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/host-agent/src/mcp-tools.ts#L91-L99) 同名工具只保留第一次拿到的 schema 和 `readOnlyHint`。桌面可以同时连接两套 ORYH。后一套同名工具的读写属性和参数模式会被忽略，写操作可能不触发页面刷新，或读操作被当成写。调用本身仍走当前会话的连接。

**建议方向。** MCP 交换设 `retryExpired: false`。错误信息用固定文案，服务端 message 不进模型上下文。分页加上限。工具元数据按连接保存，或在连接变化时重新登记。关闭重试是为了和页面写入的「结果不明不自动重放」对齐，不是因为已经观察到重复入账。

## 7. 连接元数据的两次保存会互相覆盖

**已确认。** 优先级中等（重启后刚连上的企业从文件里消失，或刚断开的摘要被旧快照写回）。

[`packages/core/src/host.ts` 第 370–372 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/src/host.ts#L370-L372) 每次把调用当时的内存列表整份交给 store。[`packages/core/src/connection-store.ts` 第 76–83 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/core/src/connection-store.ts#L76-L83) 写临时文件再 `rename`，没有进程内队列。`verifyIdentity`、`adopt`、`disconnect` 都会保存，这些异步路径可以重叠。先启动的那次 `rename` 若最后完成，磁盘上就是旧快照。

凭据在 keychain 里，和这份 JSON 不是同一次写入。恢复时，没有凭据的条目会被丢掉（`host.ts` 第 363–367 行）。结果是：重启后新连接因为不在文件里而被丢掉；或断开后的摘要被旧快照写回，但没有凭据时不会重新变成可用连接。

**建议方向。** 把 `persistConnections` 串成一条队列，写盘时读取队列执行当下的列表，而不是调用开始时的快照。补一个交错保存的测试。

## 8. 项目核对在缺少 `meta.pages` 时只看第一页

**代码与费用实现不一致已确认。ORYH 是否永远返回 `pages`，待验证。** 优先级中等（创建结果核对不到时，意图停在未知）。

[`packages/projects/src/service.ts` 第 112–121 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/projects/src/service.ts#L112-L121)：`pages` 缺失时用 `?? 1`，第一页结束后就返回。费用核对把缺失或非法的 `pages` 当成不能下结论：[`packages/expenses/src/service.ts` 第 371–373 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/expenses/src/service.ts#L371-L373)。

若列表超过 100 条且目标项目不在第一页，`projectReconcile`（第 238–248 行）匹配不到，原样返回未知记录。`projectPrepare` 在仍有 `creating` 或 `unknown` 时禁止再创建，这张意图会停在那里。匹配条件包含意图编号，所以截断更可能是漏报，而不是把别人的项目认成这一次创建。

**建议方向。** 与费用一样，`pages` 不是安全整数就拒绝核对，不要默认成 1。

## 9. 存储失败仍使用 `timesheet-conflict` 错误码

**已确认，当前界面对用户影响小。** 优先级低。

[`packages/store/src/index.ts` 第 11–19 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/store/src/index.ts#L11-L19) 写明：这个错误码是从工时存储搬出来时原样留下的，项目等存储失败也会报 `timesheet-conflict`。当前界面用 `error.message` 展示，见 [`packages/client-frame/src/client/app.tsx` 第 554–558 行](https://github.com/AIE-enginehub/oryh-ai-client/blob/7b9acee80c30f2e62c42a8fb54f0bfc30208e409/packages/client-frame/src/client/app.tsx#L554-L558)，用户看到的是调用处传入的中文说明，不是工时专用的冲突文案。

**影响。** 今天不会因为这个码弹出工时冲突说明。以后若有客户端按 `timesheet-conflict` 分支，项目或费用的存储失败会被当成工时冲突。

**建议方向。** 单独改错误码，并改掉断言了这个码的测试。不要和存储文件搬迁混在一次行为变化里。作者注释已经把这一点标成有意留待以后的改动。

## 建议修复顺序

按「已确认、能独立落地、先解除卡死和错误成功」排列。待验证项只做不依赖外部语义的那一半。

1. **费用 401 后的草稿卡死（第 4 条）。** 错误分类和状态机，改动面小，有明确的对比实现（工时）。
2. **加密目录里坏文件只隔离对应 id（第 1 条）。** 保留「不回退损坏确认」的测试，补上「其他草稿仍可读写」。密钥锁残留可以同一批处理。
3. **工时提交和费用创建回执绑定意图编号（第 5 条）。** 避免把另一次提交或另一张单据显示成这一次成功。
4. **登录网关反代去掉 `token` 查询参数（第 2 条里已确认的一半）。** 令牌用完是否必须更换，等 Harness 语义确认后再改。
5. **技能卸载前对 `installed` 做 `resolveEntry`（第 3 条里已确认的一半）。** 提示注入利用链、keyring 口令文件是否搬走、容器是否关闭 bash，等沙箱验证后再决定。
6. **MCP：`retryExpired: false`、错误文本不回显、分页上限、按连接登记工具（第 6 条）。** 关闭重试是对齐页面写入，不是宣称已经发生重复入账。
7. **连接元数据串行保存（第 7 条）。**
8. **项目列表 `meta.pages` 缺失时拒绝核对（第 8 条）。**
9. **`timesheet-conflict` 错误码（第 9 条）。** 最后做，避免和上面的行为修复缠在一起。

## 未运行的测试与环境限制

- 没有执行 `pnpm test`、`pnpm typecheck` 或 `pnpm lint`。工作区没有 `node_modules`。安装依赖会拉取 Harness 的 `link:` 包，并可能改动锁文件，超出当时的只读约束；本次也只新增本文档。
- 审核环境是 Node v22.23.4。README 要求 Node.js 24。
- 旁边没有 `deepseek-harness` 检出，因此没有核对 `c291e7961a` 的启动令牌语义，也没有核对 Landlock 不可用时 bash 的实际隔离。
- 没有构建或启动 `deploy/local` 容器，没有对 ORYH、DeepSeek 或其它生产地址发请求。
- 登录网关、密钥锁残留、连接文件交错保存、MCP 401 再 POST，在现有测试里没有对应用例。费用「损坏的最新版本不能回退」已有测试，修复第 1 条时要保住它。

## 审核没有改动的东西

这次审核没有修改业务源码、锁文件、工作流或部署配置。本文是该次意见的记录，修复应另开变更，并按上面的「已确认 / 待验证」边界取舍。
