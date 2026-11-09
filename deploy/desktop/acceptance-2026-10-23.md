# macOS Apple Silicon 桌面包验收 · 2026-10-23

业务插件源码为 main `ef4e7e5`；本轮新增打包脚本、Profile 启动配置与图标尚未提交，产物 `build.json` 标记 `clientDirty: true`。Harness 锁定在 `0.2.1-rc.2 / 687f282e86`，使用官方 unsigned Desktop 构建；没有修改或提交上游源码，保留既有 Remote 生成器补丁。

产物位于 `dist/mac-arm64/`：`ORYH AI Client.app` 和 `oryh-ai-client-ef4e7e5-mac-arm64.dmg`。`build.json` 记录 DMG SHA-256。本轮验证用 DMG 挂载后复制的独立应用进行，测试数据隔离在 `.ops-private/mac-20261023/`，截图不进入 Git。

| 验收 | 结果 |
| --- | --- |
| 官方桌面构建、内置 Node/pnpm 与基础运行时 smoke | 通过 |
| ORYH 原生 Keychain 与业务 Host 插件装载 | 通过；补齐 `@napi-rs/keyring-darwin-arm64` 可选依赖 |
| Profile 空配置、已有配置、重复初始化 | 通过；处理上游 `[]` 初始格式，保留完整的本地连接配置 |
| 安装包签名与运行时完整性 | ad-hoc 签名校验通过；50,085 个运行时文件逐项校验字节数和 SHA-256；18 个 ORYH 包随应用携带 |
| 最终 DMG 挂载、复制、全新 Profile 冷启动 | 通过；业务连接页无 Remote 404 或服务不可用错误 |
| 测试环境设备授权、Keychain 保存与企业身份 | 通过；使用已有测试账号，未在产物中写入任何凭据 |
| 真实模型查询与页面导航 | Chat 打开待办，显示 2 条未完成事项；继续打开首条待办及关联报价详情，页面与回答一致 |
| 工时对话表单 | 生成本周五天各 8 小时的预览；Chat 将周三改为 6 小时，表单与合计同步为 38 小时；未点击提交、未执行工时保存或审批 |
| 重启恢复 | 最终包恢复登录、4 轮历史会话及表单内容，不要求重新授权 |
| 模型设置 | Models、API key、Base URL、API protocol、Model ID 编辑控件可用；不改动或记录凭据值 |
| 工程检查 | 构建通过，Biome 与 `git diff --check` 通过 |

本轮发现并修复的打包问题：Electron Helper 未随应用改名、原生可选依赖遗漏、空 Profile YAML 拼接错误，以及 Profile 的 `config` 替换语义导致 `developmentOnly` 遗失。原生导入和 Profile 检查已进入构建步骤。

范围限制：只验证 Apple Silicon 本地测试包，未做 Intel、Developer ID 签发、Apple 公证或自动更新验证；未执行真实业务写入，也未覆盖所有业务对象和多账号矩阵。设置页显示中英文选项，但本轮未完成语言切换后的专项验收。没有发布到 ACS 或任何下载站。

## 桌面布局复验

根据用户提供的官方桌面版截图调整了 ORYH Frame：把原生 macOS 拖动条及折叠按钮定位到整列顶部，ORYH 标识与业务菜单在其下方；收起时为窗口按钮保留横向空间，全屏通过官方 preload 的 `data-fullscreen` 标记适配。浏览器没有 `data-platform="darwin"`，不增加桌面安全区。

左下角通过公开的 `settings.launcher` Slot 显示 ORYH 当前账号，替代上游未登录账号的 “More”。菜单复用 Harness Menu 和原生 Settings 打开回调，提供模型与设置、企业连接，以及部署本身提供的切换账号/登出操作。顶部保留企业名称。身份来自 Frame 的可观察状态，断开或切换时同步更新，不读取模型平台账号代替 ORYH 身份。

新包完成展开/收起、原生窗口切换与用户菜单实机检查，用户菜单成功打开 Harness 原生设置；登录、历史 Chat 与 38 小时预览保持。Frame 45 项及 Kit 51 项测试通过，全项目构建、类型检查、Biome、diff 检查通过。最新包仍为本地 ad-hoc 签名版本，SHA-256 以更新后的 `dist/mac-arm64/build.json` 为准。最新运行副本位于 `dist/mac-connection-verified/`；截图留在 `.ops-private/mac-20261023/`。

macOS 顶部布局的 CSS 适配沿用现有侧栏 `_logoRow` 的局部 CSS-module 几何适配方式，并使用 `_topStrip`；没有导入 Harness 私有模块或修改上游源码。升级 Harness 时需复验这两处结构选择器及原生窗口拖动/折叠行为。

后续菜单精简：业务菜单移除重复的企业连接分组，展开和图标模式均通过左下角用户菜单进入企业连接；原连接页面、设备授权及断开语义不变。Frame 45 项测试通过。

连接交互改为“切换账号 / Switch account”和“切换服务器 / Switch server”。账号切换沿用当前地址；服务器切换可输入新地址，并可返回原服务器。连接失败不移除旧连接；授权成功后的连接与已保存操作数据完整加载后，工作区才发布新选择。增加 Frame 连接流程测试与 Workspace 失败恢复测试；Frame 46 项和 Workspace 12 项通过，双语字典键保持一致。实际切换到另一台服务器的授权由测试替身验证，不使用虚构服务器进行真实登录。

连接新版桌面实机检查：企业连接页实际显示 Switch account / Switch server；点击 Switch server 出现空的新服务器地址输入框与 Back to current server；返回后仍显示原测试服务器及原账号，未执行新的真实授权。最终包的 Frame 客户端模块与 Workspace Host 模块逐项 SHA-256 对比本轮编译结果一致，原生运行时 50,085 文件校验通过。

## 桌面启动引导修复（发布前本地验收）

以下是发布前的本地验收记录。初次验收安装包基于 `871b31a` 加本地修复（`clientDirty: true`），当时尚未更新测试站或 OSS 下载入口；最终干净提交发布包见文末。

- 移除官方模型账号作为桌面启动前提：产品打包层对锁定原生壳的统一欢迎页判断做严格匹配适配；外部 Profile 关闭官方模型自动引导。未修改 Harness 仓库。
- 聊天的模型缺失、模型不可用及认证失败通过公开 `conversation.chat.node` 插槽显示双语操作指引；配额、停止、其他失败仍由原生渲染器显示，日志及会话错误原文保留。
- `pnpm verify` 通过：759 项 Vitest 测试及 3 项 Node 启动适配测试通过。5 项以 `ORYH_OWNER_HOST_TEST=1` 启用的服务端进程测试本次未启用；本次没有变更业务 Host 或服务端写入逻辑。Frame 47 项测试中包含真实 Slot 注册、卸载、非模型错误回退及中英文指引断言。
- 独立空白数据目录、从 `/tmp` 启动、系统 PATH，不注入模型环境密钥：直接进入“连接企业”，没有出现官方模型账号欢迎页；Models 设置可在企业未登录时单独打开，显示未配置密钥。
- 默认工作区实际发送只回复一句、不调用工具的消息：出现友好的缺少模型密钥提示，没有 `llm-pi-ai`、`DEEPSEEK_API_KEY` 等内部名称。通过原生设置切换中文，既有错误即时变为中文；英文也已实测。
- 使用该独立测试目录的官方凭据文件及公开 Profile 文档格式准备模型设置（不代表逐字段人工录入验收）；不在启动环境注入密钥，重启后选择模型，实际收到“模型配置已生效。”回复。企业此时尚未连接，证明模型设置独立生效。测试密钥仅保存在被忽略的私有测试目录，未进入源码、日志或安装包；另对 `app.asar` 扫描确认不含测试模型密钥。
- 换回已有验收账号的数据目录，仍不注入模型密钥：企业连接及历史会话成功恢复，模型显示未选择；“我的待办”实际刷新并显示 2 条记录。未保存、提交或审批任何业务单据。
- 原生运行时 50,087 个文件完整性检查通过；原生 keyring 及 Host 插件导入通过；应用 ad-hoc 签名深度验证通过。DMG 校验通过，挂载后复制的安装应用签名通过，`app.asar` 与实测应用 SHA-256 相同，验收挂载已卸载。

产物：`dist/mac-arm64/oryh-ai-client-871b31a-mac-arm64.dmg`，456,332,859 字节，SHA-256 `3e6b4027a97c69bd409109954ad27a6eff716643de09ed04b93b50df86fa50c5`。Apple Silicon 测试包，尚无 Apple 公证。

私有截图保存在 `.ops-private/mac-startup-20261023/`：`fresh-start.png`、`models-independent.png`、`missing-model-en.png`、`missing-model-zh.png`、`model-configured-after-restart.png`、`organization-without-model.png`。截图不进入源码提交。


## 启动流程修复版正式测试发布

修复提交 `d33d3628b3eabe5e9c06d3f086259ce33f8b6dbf` 推送后，在干净工作区重新编译产品插件并打包；`clientDirty: false`。正式 DMG 为 `dist/mac-arm64/oryh-ai-client-d33d362-mac-arm64.dmg`，457493989 字节，SHA-256 `1e74902cecb185ce5a312859ba1a33e693aec9fe6eb874e3291e76e3b33a8518`。

正式包未注入模型密钥启动，成功恢复独立测试目录的模型选择和设置，实际回复“新版验收通过。”；没有要求官方模型账号登录。运行时 50,087 个文件校验、原生插件导入、ad-hoc 签名及 DMG 校验通过；挂载后的签名与 `app.asar` 载荷比对通过，验收挂载已卸载。对正式载荷另行检查，未发现测试模型密钥。

安装包已在独立 OSS 下载 bucket 发布，匿名完整下载哈希一致；测试站中英文首页已更新到 `test-20261023-d33d362`。云端镜像构建 run 104 的 764 项测试通过，ACS 新容器就绪，首页、下载、健康检查及原登录跳转通过。完整链接、镜像及回滚记录见 `docs/60-desktop-downloads.md`。

## 企业凭据改用 Harness 服务（本地验收，尚未发布）

本轮基于 `1c0f183` 加未提交修改，锁定 Harness `687f282e` / `0.2.1-rc.2`。ORYH Connection 插件注入公开 `credentials` 服务，通过 grant records 保存企业凭据；原 Keychain 实现仅用于旧登录的延迟迁移。新登录不初始化旧适配器，迁移后的读取、刷新及退出不再访问系统钥匙串。服务器版继续使用原有托管凭据路径。

- 账号、租户、服务器和本地数据目录隔离；恢复时核验 grant 绑定，并通过服务端身份验证。刷新前读取最新持久化记录，保留 Harness 文件锁及原子写入机制。
- 旧登录只在 Harness 无记录时读取旧钥匙串；成功提交后才使用迁移结果。旧条目保留用于恢复。迁移拒绝或失败在本次 Host 内锁存，保留连接元数据且允许重新登录；未修复时下次启动可重试。退出保留无密钥标记，避免旧条目使账号复活。
- 同服务器、账号、租户重新登录会修复原连接，保留连接编号及 Chat 关联；不同身份独立存储。此处隔离是产品记录及业务身份校验，不是同一操作系统用户之间的安全边界；官方本地服务使用权限为 0600 的文件，而非钥匙串加密。
- `pnpm verify` 通过：776 项 Vitest 与 3 项 Node 测试。另在增加不同服务器、用户、租户的重新登录矩阵后，Connection 专项 19 项全部通过，包含真实官方 LocalCredentialProvider 的保存、重启恢复、0600 权限、迁移失败及注销场景。5 项需要显式环境配置的服务端进程测试未启用，没有部署服务器。
- 实机以旧验收数据的独立副本启动，迁移真实旧登录，恢复企业与账号并刷新 2 条待办；重启后实际 Chat 查询“我的待办”成功，页面联动显示 2 条未完成事项。未进行业务保存、提交或审批。
- 实机以空白独立数据目录启动，没有 DeepSeek 登录前提或钥匙串弹窗；完成测试环境设备登录，保存一个企业 grant，重启直接恢复账号和 2 条待办。最终包再次对同一账号完成登录，仍只有 `oryh-1` 一个连接和一个有效企业 grant，未出现重复账号或系统弹窗。
- 最终包运行时 50,091 文件校验、原生兼容适配器及 Host 插件加载、ad-hoc 深度签名校验通过。DMG 校验通过；只读挂载的应用签名通过，载荷与实测应用一致，验收挂载已卸载。对安装包扫描 5 个私有测试凭据值，均未发现。

最终本地安装包：`dist/mac-arm64/oryh-ai-client-1c0f183-mac-arm64.dmg`，455580149 字节，SHA-256 `f81803cd7126d99bffb5a95d471e10bf5bb568e7dc3ed952c68dab86638d1051`。Apple Silicon、ad-hoc 签名、未公证；尚未 commit、push 或更新测试站下载。首次旧登录迁移仍可能需要一次系统授权，迁移完成后不再读取旧钥匙串。

私有验收证据在 `.ops-private/mac-harness-credentials-20261023/`：`migration-first-launch.png`、`migration-restart-chat.png`、`fresh-login.png`、`final-same-account-login.png`；凭据和截图不进入源码提交。
