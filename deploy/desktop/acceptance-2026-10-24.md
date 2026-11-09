# macOS 模型 API 设置与 DeepSeek 账号解耦 · 2026-10-24

用户截图中的两处入口来自不同的上游插件：`ui-settings-account` 提供 Account 页、账号余额和登录引导；`llm-deepseek-account` 在通用 Models 页登记 DeepSeek Account 模型提供方。ORYH 只需要独立配置的模型 API。

本次产品 bundle 停用上述两个插件，以及 `account-controller`、`deepseek-account`。保留官方 `credentials`、`llm-pi-ai`、`ui-settings-models`、`ui-model-selection`、`settings-controller` 与 ORYH 企业连接。没有删除磁盘上的既有账号凭据或迁移用户 API 设置。

原生壳在判断是否显示欢迎页之前，会读取账号状态并订阅账号变更。因此同时扩展已有打包适配：启动仅从官方设置读取语言偏好，取消模型平台账号订阅；继续关闭官方模型账号欢迎页。三个适配位置任一缺失或重复都终止打包。没有修改上游仓库源码，Host 本地认证和 ORYH 业务授权保持原实现。

## 已完成验证

- 本机兄弟目录中的 Harness 已为 `0.2.1-rc.3 / 1f81c047fc`，且没有构建产物。本次在忽略目录 `.ops-private/account-settings-20261024/` 使用锁定的 `0.2.1-rc.2 / 687f282e86` 隔离构建；没有切换或改动兄弟目录中的检出。
- 产品构建、Biome、类型检查及现有 759 项 Vitest 测试通过；5 项需显式启用的服务器进程测试未运行。本次涉及桌面 Profile 与原生启动适配。
- 6 项原生适配测试通过，覆盖冷启动、语言偏好保留、不调用账号 RPC、不打开账号订阅、源结构改变/重复时阻止打包及保留原生启动的其余部分。适配亦直接应用于锁定版本实际生成的 `lib/main.js`，三个位置均匹配且 JavaScript 语法检查通过。
- `check-bundle-rows` 在锁定的 Harness 下通过。官方 launcher 的完整 Profile dump 确认 4 个账号插件停用；API 凭据、API 模型提供方、Models、模型选择器与 ORYH 插件仍启用。
- 隔离 Web Host 实际挂载设置页：侧栏只有 General、Models，无 Account；Models 只有 API 提供方，没有 DeepSeek Account。实际打开 API 编辑器并展开高级设置，确认 API key、Base URL、API protocol、Model ID 控件可用，未保存或改动凭据。
- 公共仓库导出检查及 `git diff --check` 通过。

私有构建日志、Profile dump、验证结果与截图保存在 `.ops-private/account-settings-20261024/`。本轮不发布到 OSS、ACS 或下载站，不修改现有下载链接。

## Mac 安装包与原生界面验收

- 使用锁定版本的官方 unsigned Electron 壳及本轮新编译的 ORYH 插件组装测试包。官方壳的运行时 smoke（含离线插件安装/卸载与文档运行时）、ORYH 原生 keyring/Host 插件导入、49,951 个运行时文件哈希校验和应用 ad-hoc 签名验证通过。
- 从分发 `.app` 复制原生验收副本，仅通过其 Info.plist 的 `LSEnvironment` 指定 `ORYH_DESKTOP_DATA_DIR` 并重新签名。实际数据写入私有 `native-home/`，没有读取或修改用户正式 ORYH 数据。验收副本与分发应用的 `app.asar` SHA-256 完全相同。
- 实际 Mac 冷启动直接显示 ORYH 的 Connect organization 页面，无模型账号欢迎页、启动错误或账号登录要求。打开原生设置，侧栏只有 General、Models；Models 中只显示 DeepSeek API 提供方和 Add model provider，没有 DeepSeek Account。展开 API 编辑器，API key、Base URL、API protocol、Model ID 均可用，未保存或写入模型凭据。
- 截图：私有目录的 `mac-models-en.png`、`mac-api-editor.png`。此次原生界面使用英文；语言保留由启动适配测试验证，本轮没有声称完成中文原生界面专项验收。
- 安装包：`dist/mac-arm64/oryh-ai-client-account-settings-fix-mac-arm64.dmg`，451,511,296 字节。SHA-256：`403df24546ab6d8c107497de2de7235c96284a0c91504488fac3a72b63a1f36e`。DMG 文件校验通过。
- 来源为 `1c0f183` 加本轮未提交修复，`clientDirty: true`；为 Apple Silicon 本地 ad-hoc 签名测试包。没有提交、推送或替换线上下载版本。

## 干净提交重新打包与发布

用户随后授权提交、推送、重新打包和更新线上下载入口。实现提交 `510f1bc41450dee99fae1060349b0a869f5b2ad3` 已推送至 origin/main；从独立干净检出重新编译产品插件，复用本轮已经构建并通过 smoke 的同一锁定官方壳，重新生成安装包。`build.json` 确认 `clientDirty: false`。

- 版本：`test-20261024-510f1bc`。
- 文件：`dist/mac-arm64/oryh-ai-client-510f1bc-mac-arm64.dmg`，451,978,828 字节。
- SHA-256：`179a15f1326a53941911512cb52da4456a835e344493f2985d821960411047c0`。
- 运行时文件哈希、原生 keyring/Host 插件导入、应用签名与 DMG 校验均通过。只读挂载正式 DMG 后，应用签名通过，`app.asar` 与构建应用完全相同，验收挂载已卸载。
- 发布开始时本机阿里云 CLI OAuth 凭据过期，刷新返回 400。用户完成登录与 CLI 续授权后继续发布：安装包已上传 OSS，匿名完整下载大小和 SHA-256 一致；中英文下载首页已更新。
- 正式制品记录、元数据、上传核验、云效和 ACS 发布日志均保存在 `.ops-private/releases/desktop-account-settings-20261024/`。云效 run 106 的 764 项测试通过，服务端 dry-run 和滚动更新通过；健康检查、登录跳转、新旧下载链接、版本、哈希与 PVC 绑定复核通过，临时运维白名单已移除。镜像、下载地址与回滚记录见 `docs/60-desktop-downloads.md`。

## Harness 企业凭据服务版 · 发布前复验

实现提交 `1f79ef4` 与远端账号设置修复合并于 `8741c4fb12982eefc2658b0c498485643cbe81d9`，已推送 main。合并后的 `pnpm verify` 通过：779 项 Vitest 测试和 6 项原生启动适配测试；本地未启用的 5 项服务端进程测试由云端正式镜像构建执行。凭据迁移、失败恢复、同账号重新登录、不同服务器/账号/租户隔离等专项和前一日实机验收见 `acceptance-2026-10-23.md` 文末。

- 从干净提交重新编译插件并打包，复用锁定 Harness `687f282e86 / 0.2.1-rc.2` 的同一官方 Electron 壳；`clientDirty: false`。50,091 个运行时文件校验及原生兼容适配器、Host 插件导入通过。
- 正式包使用独立私有测试目录、不注入模型环境密钥启动：恢复企业账号、模型配置与历史会话，没有 DeepSeek 登录前提或系统钥匙串弹窗。实际 Chat 请求打开待办列表并查询未完成数量，5 秒完成，列表及回答均为 2 条；没有业务写入。
- 原生设置实际只有 General、Models，API 提供方及已配置密钥状态正常，没有 Account 页。保存截图后退出测试应用，没有改动正式用户数据目录。
- DMG 校验、只读挂载应用的 ad-hoc 深度签名校验通过；挂载载荷与实测应用相同，挂载已卸载。扫描安装包中的 5 个私有测试凭据值均未发现。
- 安装包：`dist/mac-arm64/oryh-ai-client-8741c4f-mac-arm64.dmg`，454525289 字节，SHA-256 `f40e2f8732454568c45adc96d3335b625959d07ad48c8cc2f9f8e3ac57e37b44`。Apple Silicon、ad-hoc 签名、未经 Apple 公证。

私有证据和发布前集群备份在 `.ops-private/releases/desktop-credentials-20261024/`，包含 `mac-chat.png`、`mac-model-settings.png`、制品记录、运行时与 DMG 检查及部署配置/PVC 元数据。发布结果见 `docs/60-desktop-downloads.md` 后续记录。

## 远端与本地弹窗修复的审查合并

拉取的远端基线为 `525d299`，弹窗修复实现为 `1f79ef4`，已发布包的源码合并点为 `8741c4f`。本地未提交方案也使用 Harness 凭据服务，但每个数据目录只有一份汇总记录；远端按连接保存，并增加了服务器/用户/租户绑定、拒绝迁移后的恢复及跨 Host 刷新前重读。两边不能直接叠加使用。

- 采用远端的每连接存储、身份绑定、旧钥匙串迁移、错误恢复和刷新机制，不保留本地的另一套 vault 实现。保留本地的凭据文案修正与历史重复连接的启动恢复逻辑。
- 增加本地验证包汇总格式到每连接格式的迁移，避免已用过本地验证包的账号丢登录或重新读取钥匙串。新记录及其注销标记优先；原汇总记录保留，格式损坏不回退到钥匙串。
- 修正远端迁移缓存的边界：只缓存迁移状态，后续读取始终查询当前记录；写入、退出后的状态也阻止重新访问旧存储。外部删除记录后不会返回缓存的旧凭据。
- 对齐重新授权与冷启动的重复连接选择：两者使用最新的匹配连接，保留连接编号和会话关联；不同主体不自动混选。
- 在锁定的 Harness `0.2.1-rc.2 / 687f282e86` 隔离检出中运行完整 `pnpm verify`：构建、Biome、类型检查、公共导出、790 项 Vitest 测试和 6 项原生壳测试通过；5 项需显式启用的服务端进程测试未运行。没有切换或提交兄弟 Harness 仓库。
- 用前一本地验证包的真实登录和会话数据升级原生副本：汇总记录由 1 条转换为 2 条每连接记录，原汇总记录与模型 API refs 保持不变。企业登录与旧会话恢复，实际模型回复“合并后已读取历史：冷启动后模型调用正常。”，再次冷启动成功；两次探针自测通过，正常流程钥匙串访问为 0。测试副本已关闭，没有修改正式用户目录。

本地原始改动保存在 Git stash 和 `.ops-private/keychain-merge-20261024/`，该目录亦保存日志、迁移前备份、原生截图和验收结果。远端已发布版本的下载、哈希与 ACS 部署记录保持原样；本轮没有推送或更新线上包。

## 审查合并版干净提交发布复验

用户随后授权提交、推送与重新发布。实现提交 `07d85332194c61a755b2f36e49045d63360b4784` 已推送，干净检出重新编译并打包，正式候选包 `clientDirty: false`，SHA-256 `268a9f3c5ad0172d97cb6e9545e4d7432af3a785dc24d9c46ad25aa900aca3a7`。

- 复用锁定的同一官方 Harness 壳，运行时 49,955 个文件哈希和 Host 插件导入检查通过；DMG 校验、挂载应用 ad-hoc 深度签名与实测载荷比对通过，分发包不含测试环境覆盖。
- 正式候选包实际恢复企业登录、API 配置与旧会话，模型回复“正式发布包模型调用正常。”；再次冷启动保留该回复与企业登录，探针两次自测通过，正常流程钥匙串调用 0 次。保存证据后通过应用菜单退出测试副本。
- 6 个本机测试凭据值在安装载荷中均未匹配；测试目录、密钥、Session 和探针不进入分发包。
- 已匿名完整下载 OSS 制品，体积、SHA-256、Range 206 和下载头验证通过；云效 run 108 的 795 项测试通过，未跳过正式镜像校验。后续首页及集群发布结果见 docs/60。
