# FlyLaTeX 社区版

[English](./README.md) | **简体中文**

一个基于 **Overleaf Community Edition** 的 LaTeX 协作平台。

本仓库包含我们能够公开的代码，足够你跑起编辑器：注册登录、建项目、写和编译文档、邀请协作者、导出 PDF。
它**不包含**我们在其之上运营的商业系统，见后文[「不包含什么」](#不包含什么)。

---

## 上游与许可证

本项目 fork 自 Overleaf 的开源代码库：

| 项 | 值 |
| --- | --- |
| 上游项目 | https://github.com/overleaf/overleaf |
| 本 fork 基于的上游提交 | `811172f1fa` — *Merge pull request #16528 from overleaf/jdt-wf-settings-copy*，2024-01-16 |
| 该提交处的上游包版本 | `@overleaf/settings` 3.0.0、`@overleaf/logger` 3.1.1、`@overleaf/metrics` 4.1.0、`@overleaf/fetch-utils` 0.1.0、`@overleaf/object-persistor` 1.0.2 |
| 兼容的容器底座 | `sharelatex/sharelatex:5.1.x`（社区版镜像仅支持 x86-64） |
| 许可证 | **AGPL-3.0**，见 [LICENSE](./LICENSE) |

Overleaf Community Edition 以 GNU Affero 通用公共许可证第三版发布。我们沿用同一许可证、保留上游版权声明，
并按 AGPL 的要求，把我们的修改以相同条款公开。

`libraries/`（`npm ci` 会从磁盘解析的 `@overleaf/*` 内部包）已按同一上游提交一并收录，因此这份代码树可以独立构建。

**商标说明。**「Overleaf」是 Overleaf Ltd. 的商标，「LaTeX」属于 LaTeX Project。AGPL 授予的是**代码**许可，
不包含名称与标识的使用权。文件中仍然可见的上游提示语保持原样；我们自己的品牌一律使用「FlyLaTeX」。

---

## 不包含什么

你在配置或界面里可能看到的一些能力，由我们运营的**独立商业系统**提供。它们不在本仓库中，
原因是其中包含合作方凭据、商业定价与客户数据：

| 领域 | 我们线上怎么做的 | 本仓库里的情况 |
| --- | --- | --- |
| 账号体系 / 登录 | 一个外部用户中心，通过 OAuth2 + 密码传输协议对接（`overleaf-ne-login/`） | 集成代码与接线在，但地址为占位符，无任何凭据 |
| 高校联合登录（CARSI 类） | 同一个外部用户中心 + 机构管理服务 | 未配置，仅保留适配层 |
| AI 助手后端 | 我们自建的 LLM 网关，配按用户下发的凭证 | 保留 `LLM_*` 配置与 OpenAI 兼容的协议适配器；网关本身及其 key 不提供 |
| 计费与支付 | 外部托管的第三方收银台 + 内部追加式账本 | 账本与计费**代码**在，完全由配置驱动；无商户凭据、无真实价目 |
| 会员 / VIP | 我们自己的套餐服务 | 套餐数据不含；价格走配置 |
| 生态应用 SSO | 我们维护的客户端注册表 | 协议实现（OAuth2 + PKCE）在；注册表默认空数组，端点自动关闭 |
| 白板、论文模板库、TikZ 模板库、运营/门户台 | 各自独立部署的服务 | 仅保留链接或占位 |
| 个人知识库、文献检索 | 由我们的网关代理的外部服务 | 适配层在，端点未配置 |
| 运维工具（导航菜单管理、部署 runbook、构建流水线） | 内部仓库 | 不包含 |

一句话概括：**这些系统的缺失不影响你使用产品本身。**
你可以注册普通账号、建项目、写和编译 LaTeX、邀请协作者、导出 PDF。
你得不到的是我们对外销售的商业附加能力——它们是独立产品，通过 HTTP 与本系统对接，而不是这套代码里的组成部分。

默认配置刻意做到「零商业依赖」：真实部署会用自己的一份私有配置替换
`services/web/config/internal-values.example.js`，详见下节。

---

## 环境要求

* Node.js 18（上游代码属于 Node 18 时代）
* MongoDB 5+（应用强制要求副本集，即使单节点）与 Redis
* 若在同一台机器编译文档，需要 TeX Live
* 可选：Docker，如果你想按已发布镜像的方式构建

## 快速开始

```bash
# 安装依赖（所有 @overleaf/* 包从 ./libraries 解析）
npm ci --workspace services/web --include-workspace-root

# 配置：复制示例，填入你自己的值
cp services/web/config/internal-values.example.js services/web/config/internal-values.js
$EDITOR services/web/config/internal-values.js

# 启动（开发模式）
cd services/web
npm run start:dev
```

应用默认连接 `mongodb://mongo/sharelatex` 与 `redis`，两者都可用
`MONGO_CONNECTION_STRING` / `REDIS_HOST` 覆盖，其余变量见
`services/web/config/settings.defaults.js` 中的注释。

### 重新构建前端

```bash
cd services/web
npm run webpack:production     # 或 npm run webpack:dev
```

---

## 配置

所有私有值集中在一个文件：

```
services/web/config/internal-values.js          # 你的值，永远不要提交
services/web/config/internal-values.example.js  # 随仓库分发的模板
```

其中的每一项都可以用环境变量覆盖，容器化部署建议这么做（见 `settings.defaults.js` 注释）。常用的有：

| 变量 | 含义 |
| --- | --- |
| `APP_NAME`、`SITE_URL`、`PUBLIC_URL` | 品牌名与绝对地址 |
| `MONGO_CONNECTION_STRING`、`REDIS_HOST` | 数据存储 |
| `LOGIN_PASSWORD` / `LOGIN_SMS` / `LOGIN_CARSI` / `LOGIN_GOOGLE` | 开放哪些登录方式 |
| `GOOGLE_CLIENT_ID` | 启用 Google 登录（需在 Google 侧授权 JavaScript 来源） |
| `LLM_PROTOCOL`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_DEFAULT_MODEL` | AI 助手上游，任何 OpenAI 兼容端点均可 |
| `BILLING_ENABLED`、`BILLING_PROVIDER`、`BILLING_*` | 可选的计费；普通安装保持关闭 |
| `SSO_CLIENTS` | SSO 提供方的客户端注册表；为空即关闭 |

若一门登录方式都不可用，应用会**故意**回落放开密码登录并记一条 error 日志，避免配置疏漏把所有人锁在门外。

有用的自检：

```bash
cd services/web
npm run check:no-hardcoded-secrets   # 除 internal-values 外不得出现凭据
npm run check:sso-config             # SSO 注册表自检
node scripts/i18n-llm/verify.js      # 翻译词表一致性
```

---

## 目录结构

```
libraries/                  收录的 @overleaf/* 工作区包（对应上表的提交）
patches/                    patch-package 补丁（上游依赖树必需）
services/web/               主 Web 应用（Express + React）
  app/                      服务端
  frontend/                 客户端
  config/                   settings.defaults.js 与 internal-values(.example).js
  locales/                  翻译词表
services/clsi/              编译服务
services/document-updater/  文档历史 / OT 服务
services/*                  其余上游服务（chat、contacts、filestore、real-time 等）
```

## 参与贡献

欢迎提 Issue 与 PR。请勿把凭据、私有端点、客户数据带进提交；
`check:no-hardcoded-secrets` 属于评审门禁。

## 致谢

FlyLaTeX 能够存在，是因为 Overleaf 把社区版以 AGPL 公开。
我们沿用同样的许可证、同样的态度，以及在可能之处同样的代码。
