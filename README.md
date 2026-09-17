# ORYH AI Client

ORYH 的 AI 客户端：在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上以外部 Host 插件、Client 插件和 `oryh-web` Profile 运行。

界面分三栏：左侧是业务菜单，中间是传统业务页面，右侧是 Chat。启动、认证、会话、模型设置和插件生命周期由 Harness 提供；本仓库的插件提供 ORYH 的企业连接、业务列表和表单：每个业务领域一个 Host 插件和一个 Client 插件，由面板桥把 Chat 和中间栏的页面连在一起。

## 能力

- **待办**：查看分配给自己的待办及其关联单据。
- **工时**：查询、新建、编辑、提交；经理可以审批。
- **费用**：本地加密草稿、核对确认、创建与提交。
- **项目**：查询与新建。
- **销售订单、库存、收发货**：查询与筛选，可以把常用筛选存成自己的菜单项。
- **Chat**：agent 通过 ORYH 的 MCP 与技能读写业务数据，也可以直接打开中间栏的页面和表单。写入前是否需要确认，由 ORYH 下发的技能决定。

凭据只保存在 Host 侧和系统钥匙串，浏览器通过生成的类型化 Remote 调用业务服务。每个会话固定绑定一个 ORYH 租户和员工身份。

## 用 Docker Compose 运行

需要 Docker，以及并列放置的两个源码目录：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout c291e7961a
git clone https://github.com/AIE-enginehub/oryh-ai-client.git
cd oryh-ai-client
```

Harness 固定在 `c291e7961a`：本仓库依赖一处尚未合入上游的外部插件 Remote 修复（`patches/`），补丁按这个版本导出，镜像构建时自动打上。

复制 `.env.example` 为 `.env`，填写 ORYH 服务端地址和模型配置，然后：

```sh
docker compose build --build-arg DSH_CLIENT_COMMIT_HASH="$(git -C ../deepseek-harness rev-parse HEAD)"
docker compose up -d
```

浏览器打开 `http://127.0.0.1:4180/`，用 ORYH 账号登录并授权，即可进入工作台。这是**单用户**客户端：第一个登录的账号就是这个容器的使用者。详细说明、模型配置和数据卷见 [本地 Compose 指南](deploy/local/README.md)。

## 本机开发

需要 Node.js 24、pnpm 11，以及同级目录下的 `deepseek-harness`（本仓库通过 `link:` 依赖它）。Harness 要检出 `c291e7961a`，先打上补丁再安装和构建，否则 `pnpm build` 的补丁检查会报错：

```sh
git -C ../deepseek-harness apply ../oryh-ai-client/patches/deepseek-harness-external-remote.patch
pnpm install
pnpm build      # 构建插件并生成 Remote
pnpm verify     # 类型检查与测试
pnpm start      # 启动 oryh-web Profile
```

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `packages/foundation`、`pages`、`store` | 共享基础：错误类型与标识、业务页面目录、加密的版本化存储 |
| `packages/core` | Host 侧 ORYH 运行时：连接、凭据、确定性操作与加密草稿 |
| `packages/workspace` | 浏览器可用的企业选择与工作台状态 |
| `packages/timesheets`、`expenses`、`projects`、`records`、`todos` | 各业务领域的操作与校验 |
| `packages/host-connection` | Host 插件：企业连接、技能与 MCP 客户端（Remote 命名空间 `oryh`） |
| `packages/host-pane` | Host 插件：面板桥，把 Chat 会话绑定到中间栏页面，传递页面状态与 agent 命令 |
| `packages/host-todos`、`host-timesheets`、`host-expenses`、`host-projects`、`host-records` | 各业务领域的 Host 插件 |
| `packages/host-agent` | ORYH 业务 agent：系统提示、工具与 MCP 接入 |
| `packages/client-frame` | 浏览器端框架：三栏布局、菜单、企业连接页、面板桥 |
| `packages/client-todos`、`client-timesheets`、`client-expenses`、`client-projects`、`client-records` | 各业务页面的 Client 插件 |
| `packages/dsh-bundle` | `oryh-web` Profile 与插件打包 |
| `deploy/local` | 单用户容器：登录网关与模型配置 |

## 许可证

[Apache License 2.0](LICENSE)。
