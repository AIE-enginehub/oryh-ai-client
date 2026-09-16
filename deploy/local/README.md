# 本地 Compose 业务验证

这是完整 ORYH **单用户开发版**的容器入口。运行原生 DeepSeek Harness Web Profile 与 ORYH 外部插件，不是多用户服务器版；不要用于多租户隔离验收或对公网开放。

## 启动

源码目录必须并列放置：`deepseek-harness/` 与 `oryh-ai-client/`。在 `oryh-ai-client/` 执行：

```sh
cp .env.example .env   # 填写模型配置，见「模型」
docker compose build --build-arg DSH_CLIENT_COMMIT_HASH="$(git -C ../deepseek-harness rev-parse HEAD)"
docker compose up -d
docker compose logs client
```

## 登录

浏览器打开 `http://127.0.0.1:4180/`，会跳转到 ORYH 的登录页。用 ORYH 账号密码登录并点「授权」后回到工作台，企业连接已自动建立，不需要再做设备授权。浏览器 Cookie 有效期内再次访问直接进入。

- **第一个登录的 ORYH 账号就是这个容器的使用者。** 这是单用户客户端，之后换其他账号登录会被拒绝，避免看到前一个人的会话和数据。要换人，删除数据卷重新开始（见下文）。
- 同一账号再次登录，只更新这条企业连接的凭据，不会重复添加连接。
- 服务端地址由 `.env` 的 `ORYH_SERVER_ORIGIN` 决定，指向你的 ORYH 部署。

实现：容器里唯一对外的监听是登录网关 [`login-gateway.mjs`](login-gateway.mjs)。它用 ORYH 的 OAuth 2.1 授权码 + PKCE 登录，回调地址是回环地址 `http://127.0.0.1:4180/oryh/callback`；登录成功后用只有它能读到的 DSH 启动令牌换取 DSH 自己的会话 Cookie，并把同一份凭据以 0600 文件交给客户端（`ORYH_CREDENTIAL_HANDOFF`，客户端读取后立即删除，凭据转存进 Linux Secret Service）。其余请求原样转给容器内 `127.0.0.1:4174` 的 Harness，Host、Origin 和 Cookie 校验照旧。启动令牌不再打印到日志。

## 模型

模型是部署的全局配置，所有使用者共用，浏览器里没有模型设置页，也没有会话级的模型切换。在 `oryh-ai-client/` 下复制 `.env.example` 为 `.env` 并填写：

| 变量 | 含义 |
| --- | --- |
| `ORYH_SERVER_ORIGIN` | ORYH 服务端地址（必填） |
| `ORYH_MODEL_API_KEY` | 模型 API Key（必填；未填 `docker compose up` 直接报错） |
| `ORYH_MODEL_BASE_URL` | 模型服务地址，默认 `https://api.deepseek.com` |
| `ORYH_MODEL` | 模型 ID，默认 `deepseek-v4-flash` |
| `ORYH_MODEL_REASONING_EFFORT` | `off` / `low` / `high` / `max`，默认 `high` |

改完执行 `docker compose up -d` 生效。Key 以容器环境变量 `DEEPSEEK_API_KEY` 传给 Harness：它优先于任何页面保存的值且只读，并且不会传进 agent 运行的 shell。`.env` 不提交、不进镜像。容器每次启动由 [`model-config.mjs`](model-config.mjs) 写入 Profile 补丁，并清除用户设置层里旧的模型配置，保证以部署配置为准。

Chat 的工作区选择容器内 `/home/node/workspace`。主机上的企业凭证和文件不会自动复制进容器。

## 数据与生命周期

- `client-data` 命名卷保存 Profile、模型配置、会话、工作区和业务草稿。
- ORYH 业务凭证及草稿加密密钥由容器内 Linux Secret Service 保存。其自动解锁密码随机生成于命名卷私有文件，权限为 0600；这是信任同一 UID 的单用户开发部署，不提供服务器多用户秘密隔离。
- `docker compose stop` 停止；`docker compose up -d` 再启动。普通 `docker compose down` 保留数据。
- **不要使用 `docker compose down -v`，除非要永久删除上述数据。**
- 更新源码后重新 build、up；不在镜像中保存 ORYH 密码或模型 API Key。

## 本机验证限制（2026-09-15）

当前 Docker Desktop 内核为 `5.15.49-linuxkit-pr`。Landlock 实际探针返回 `ENOSYS`（系统调用未实现），因此不能据此验收 Chat 的受限脚本执行。镜像已包含 Harness 原生 Linux 沙箱程序，但没有关闭安全策略、切换 Full Access 或使用 privileged 容器。业务页面与企业连接入口可供操作；模型配置和需要脚本执行的技能应分别验证，不能把页面健康检查视为 Chat 全链路成功。
