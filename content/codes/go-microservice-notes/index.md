---
title: "Go 微服务选型杂谈"
date: 2026-08-10T20:10:00+08:00
isCJKLanguage: true
draft: true
tags: ["go", "microservices", "grpc", "connect-rpc", "grpc-gateway", "openapi", "protobuf", "kratos", "ent", "gorm", "tech-selection"]
---

过去几周我在公司的两个项目上做了些调研和初步开发：一个是统一认证鉴权服务（authx），另一个是管理面 API 网关（api-server）。虽然这部分工作目前暂停了，但调研过程中做的几组技术横向对比值得记录下来：

- gRPC 生态对比：Connect-RPC vs gRPC（和 gRPC-Gateway）
- OpenAPI 的几个 proto 生成器对比
- 校验信息注解对比：grpc-gateway OpenAPI 注解 vs Protovalidate 注解
- ORM 框架对比：ent vs GORM
- 状态码风格对比：HTTP/gRPC status code vs 自定义信封
- web 层框架对比：[gin](https://github.com/gin-gonic/gin) / [chi](https://github.com/go-chi/chi) / [echo](https://github.com/labstack/echo) / [kratos](https://github.com/go-kratos/kratos) `protoc-gen-go-http`
- go-kratos 生态的默认技术栈与推荐的 service 层次划分

authx 的方案做得更早，后来引入 api-server 作为管理面的统一 HTTP 入口，由它代理所有管理面请求，与 authx 等下游服务之间主要走 gRPC。authx 的几个决策也因此被重新评估的。下文有些对比来自实际编码体验（ent、kratos 分层），有些停留在调研结论（OpenAPI 生成器、Connect-RPC 的大部分论据）。

团队此前已有两套系统在运行：一套基于开源 [new-api](https://github.com/QuantumNous/new-api) 项目，负责推理请求的路由与计费，是 Go + Gin + GORM 技术栈；另一套是自研的推理服务部署项目，负责拉起推理服务、承接请求，用的是 Python + FastAPI。在做方案时我也仔细考量了这些已有项目所使用的技术栈。

## 1. Connect-RPC vs gRPC

### 1.1 两套方案

- **gRPC + [gRPC-Gateway](https://github.com/grpc-ecosystem/grpc-gateway)**：gRPC-Go 做 RPC，gRPC-Gateway 依据 proto 里的 `google.api.http` 注解生成 HTTP/JSON → gRPC 的转码代理，HTTP 路径、参数映射、请求体绑定全部在注解里显式声明。
- **Connect-RPC（Go 实现为 [connect-go](https://github.com/connectrpc/connect-go)）**：bufbuild 开发的 RPC 框架，生成的 handler 就是一个标准的 `net/http` handler，同一份服务实现同时支持 Connect、gRPC、gRPC-Web 三种协议，浏览器可直接调用，不需要额外代理。但 HTTP 路径是约定式的 `POST /{package}.{Service}/{Method}`，不支持自定义。

两者对 HTTP 路径的控制粒度，用同一个 `SessionService` 对比如下。gRPC-Gateway 一侧，HTTP 语义在 proto 里显式声明：

```proto
service SessionService {
  rpc GetSession(GetSessionRequest) returns (GetSessionResponse) {
    option (google.api.http) = { get: "/v1/sessions/{id}" };
  }

  rpc Login(LoginRequest) returns (LoginResponse) {
    option (google.api.http) = {
      post: "/v1/sessions:login"
      body: "*"
    };
  }
}
```

HTTP 方法、路径风格、路径参数与请求字段的绑定（`{id}`）、请求体映射（`body`）都可以逐项配置，还可以用 `additional_bindings` 给同一个 RPC 加挂旧路径做兼容。Connect-RPC 一侧没有这些配置项，同样的两个 RPC 对外只有约定式路径：

```text
POST /auth.v1.SessionService/GetSession
POST /auth.v1.SessionService/Login
```

方法恒为 POST，路径由「包名.服务名/方法名」推导，请求体恒为整个请求消息。前者是 REST 风格的资源路径，后者是 RPC 风格的调用路径——这个差异决定了它们各自适合的场景。

### 1.2 网关场景

api-server 是平台管理面 HTTP/JSON 到内部 gRPC 的统一入口，核心诉求之一是**集中、精细地控制公开 HTTP 契约**。对照这个诉求看 Connect-RPC，有几处不匹配：

1. **暴露控制粒度不够**：需要按 `google.api.http` 注解和 gateway 生成输入集精细控制哪些 RPC 暴露为 HTTP，Connect-RPC 无法做到。
2. **HTTP 路径与参数映射不可定制**：Connect-RPC 的路径是约定式的，无法像 `google.api.http` 那样显式声明 method/path/body，也做不了 `additional_bindings`（旧路径兼容）。
3. **生态成熟度**：Connect-RPC 生态里做转码的 [`vanguard-go`](https://github.com/connectrpc/vanguard-go) 仍处于试验阶段。
4. **协议数量**：已有 HTTP/JSON + gRPC 两条协议，不值得再引入第三种协议和新的网关运行时。

基于此，倾向于不引入 Connect-RPC，HTTP/JSON 到 gRPC 的转码交给注解驱动的 gRPC-Gateway。

### 1.3 独立服务场景

authx 是独立的认证鉴权服务，处境和网关不同：

- 服务自身是 proto-first 的，希望 HTTP/JSON 与 gRPC 双传输一站解决，不想再维护一套网关；
- 考察同为认证鉴权系统的开源实现时，[ZITADEL](https://github.com/zitadel/zitadel) 的技术栈与目标完全一致（Go + Connect-RPC + buf）；
- authx 需要自己暴露少量 HTTP-only 端点：OAuth/OIDC 的 authorize/callback 302 跳转、登录态的 `Set-Cookie`、JWKS 与 well-known 发现端点，这些端点用 Web 框架承载、与 RPC handler 共用同一监听端口即可。

基于此，当时选了 connect-go v1.20：生成的 handler 就是标准的 `net/http` handler，经 `gin.WrapH` 挂进 Web 框架，与这些 HTTP-only 端点共用端口，实现起来很自然。

### 1.4 方案演进与小结

api-server 引入之后，1.3 的前提变了。所有管理面 HTTP 入口收敛到网关，原本规划由 authx 直接承担的 HTTP-only 端点（OIDC callback、`Set-Cookie`、JWKS）都可以委托给 api-server，authx 只在 gRPC 层提供底层能力：签发和校验 token、管理 session、做权限决策。

connect-go 的 HTTP 能力因此不再被直接使用，继续用它反而多维护一层概念，不如换 [grpc-go](https://github.com/grpc/grpc-go) 与下游服务保持一致。这也是 go-kratos 实施时 authx 的实际形态：proto 只生成 `*_grpc.pb.go`，HTTP server 仅保留健康检查等最基础的非业务端点。

所以两个项目在方案演进后收敛为同一形态：**网关用 gRPC-Gateway，下游服务用 grpc-go**。需要把 HTTP 路径当公共契约精细管理时，注解驱动的 gRPC-Gateway 更合适；服务自身 proto-first、且 HTTP 入口已被网关收敛时，直接走 grpc-go 更轻量。

## 2. OpenAPI 的 proto 生成器对比

OpenAPI 这块的选型要从 HTTP 映射的管理方式说起。api-server 最初的设想是完全建立在 gRPC-Gateway 的外置 YAML（`grpc_api_configuration`）上，把所有 HTTP 路径映射集中在一处管理，而不是用 `google.api.http` 注解侵入式地分散在各个 proto 里——gRPC-Gateway + `protoc-gen-openapiv2` 这一套都能与外置 YAML 配合，看起来很顺。

两种方式表达的是同一份映射。外置 YAML 把它们集中在网关侧的一个文件里，按 RPC 全名（`selector`）逐个指定：

```yaml
http:
  rules:
    - selector: auth.v1.SessionService.GetSession
      get: "/v1/sessions/{id}"
    - selector: auth.v1.SessionService.Login
      post: "/v1/sessions:login"
      body: "*"
```

内嵌注解则把同样的内容分散写进各个 proto 的 RPC 定义上（写法见 1.1 的例子）。前者的吸引力在于 HTTP 层完全由网关侧控制，不需要下游 proto 配合改动。

深入考察后发现两个问题。一是 proto 生态里的众多生成器——包括 kratos 的 `protoc-gen-go-http` 和各 OpenAPI 生成器——都只认 proto 内嵌的 `google.api.http` 注解，外置 YAML 的支持面比想象中窄，连 gRPC-Gateway 自家的 `protoc-gen-openapiv3` 目前也尚未支持外置 YAML。二是前端契约需要 OpenAPI v3，而 openapiv2 只出 Swagger 2.0，既然生成器要换，也就没必要锁定在 grpc-gateway 自家的这一套上。

于是 HTTP 映射改为写进 proto 注解——同一份 proto 可以同时作为 gRPC-Gateway、kratos 和 OpenAPI 生成器的输入；OpenAPI v3（3.0.x）生成器也随之重新选型，不再使用「`protoc-gen-openapiv2` 生成 Swagger 2.0、再用 [kin-openapi](https://github.com/getkin/kin-openapi) 转成 v3」的老流程。一共考察了四个候选，分别来自 `grpc-gateway`、`google/gnostic` 和 `protoc-gen-connect-openapi` 三个项目：

| 生成器 | 输出版本 | 成熟度 | [Protovalidate](https://github.com/bufbuild/protovalidate) 映射 | 其他 |
|---|---|---|---|---|
| grpc-gateway `protoc-gen-openapiv2` | OpenAPI 2.0（Swagger） | 成熟，生产环境广泛使用 | 不识别 protovalidate 注解 | 自带 `openapiv2_field`/`openapiv2_schema` 注解，可手写约束进文档，但同一套信息后端复用不了；要得到 v3 需 kin-openapi 二次转换 |
| grpc-gateway `protoc-gen-openapiv3` | OpenAPI 3.x | 较新，仍标注 experimental | 不识别 protovalidate 注解 | 功能覆盖和打磨程度尚不如 v2 |
| google/gnostic [`protoc-gen-openapi`](https://github.com/google/gnostic) v0.7.1 | OpenAPI 3.0.x | 较成熟 | 不识别 protovalidate 注解，约束字段要后处理补 | `strategy: all` 生成单文件 |
| [`protoc-gen-connect-openapi`](https://github.com/sudorandom/protoc-gen-connect-openapi) v0.25.7 | 默认 3.1.0，需降版本或接受 3.1 | 活跃但较新 | 识别并支持一部分 protovalidate 注解，`required`/`min/max`/`pattern`/`enum` 等直接进 schema | 默认生成 Connect 协议内容，需从 `features` 中去掉 `connectrpc`；`trim-unused-types` 按方法引用裁剪，未被引用的 message 仍可能进入文档 |

grpc-gateway 的两个生成器位置很典型：openapiv2 成熟但只出 Swagger 2.0，openapiv3 能出 v3 但还不成熟——「能出 v3」和「敢用在生产」之间隔着一段距离，这也是进一步考察 gnostic 和 connect-openapi 的原因。

connect-openapi 用 `features` 选项控制启用哪几套注解体系，一共有五个可选项：

- `connectrpc`：Connect RPC 的 HTTP 路径
- `google.api.http`：gRPC-Gateway 风格注解
- `twirp`：启用 [Twirp](https://twitchtv.github.io/twirp/docs/intro.html) 服务路径生成
- `gnostic`：gnostic 项目的 OpenAPI v3 注解
- `protovalidate`

默认启用除 `twirp` 外的四个，而一旦显式设置就只启用列出的项——所以要让输出不含 Connect 协议内容，实际写法是 `features=google.api.http;gnostic;protovalidate`。

connect-openapi 的 `trim-unused-types` 裁剪也不太干净：它按方法请求/响应引用来决定 schema 是否保留，但即使显式从 `features` 中去掉 `connectrpc`、只生成 `google.api.http` 注解的 HTTP 路径，那些未使用 `google.api.http` 注解的 RPC 所引用的 schema 也不会被裁掉。如果不考虑这一点，connect-openapi 是四个候选里最被推崇的一个：唯一内置 protovalidate 映射，同时认 gRPC-Gateway 和 gnostic 两套注解，覆盖面最全。

这个选型最终没有定下来，目前生成流程中使用的是 gnostic 的 `protoc-gen-openapi`，protovalidate 约束字段由后处理补。

### 2.1 文档注解与校验注解的分工

同一个字段上，两套注解可以并存：

```proto
string username = 1 [
  // grpc-gateway 的 OpenAPI 注解：面向文档
  (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
    min_length: 1
    max_length: 64
    pattern: "^[a-zA-Z0-9_-]+$"
  },
  // Protovalidate 注解：面向运行时校验
  (buf.validate.field).string = {
    min_len: 1
    max_len: 64
    pattern: "^[a-zA-Z0-9_-]+$"
  }
];
```

| | grpc-gateway OpenAPI 注解 | Protovalidate 注解 |
|---|---|---|
| 写法 | 直接写 JSON Schema 关键字（`min_length`、`pattern`），面向文档描述 | 按字段类型组织规则（`string.min_len`、`enum.defined_only`），面向校验语义 |
| 生效范围 | 只进 OpenAPI 文档，给前端看 | 后端运行时校验（gateway 拦截器、服务内执行） |
| 另一侧是否可见 | 后端完全读不到 | 文档默认读不到，除非生成器内置映射或后处理补充 |

工程规则上，同一条校验信息没必要在 proto 里写两遍：后端用 **[Protovalidate](https://github.com/bufbuild/protovalidate)** 做运行时校验，OpenAPI 文档里的 `min`/`max`/`pattern`/`required` 等约束字段也从这些规则映射或后处理生成，而不是在文档侧再手写一份。具体怎么映射，取决于生成器选型——connect-openapi 能直接生成，gnostic 和 grpc-gateway 则需要后处理阶段补充。

## 3. ent vs GORM

最初选择的 ORM 框架其实并不是 [ent](https://entgo.io)。方案设计阶段选择了 [GORM](https://github.com/go-gorm/gorm) v2，理由是向 [new-api](https://github.com/QuantumNous/new-api) 的技术栈看齐；进入实施阶段后，leader 指定使用 go-kratos 生态，数据层随之换成了生态内常见的 ent。这次切换也是一次对 go-kratos 生态设计的实际体验。

### 3.1 模型层面的差异

| 维度 | GORM | ent |
|---|---|---|
| 模型定义 | struct + tag，运行时反射 | `ent/schema` 下用 Go 代码声明字段/索引/边（`ent.Edge`），代码生成出类型安全的 Client |
| 查询 | 链式 API，字段名是字符串 | 生成代码，谓词/排序/翻页全部编译期检查 |
| 关联 | `Preload` + tag 约定 | `Edges()` 显式声明，生成 `QueryXxx()` 遍历方法 |
| 迁移 | `AutoMigrate` 能力有限，通常另配 [golang-migrate](https://github.com/golang-migrate/migrate) | 自带 schema migration（`client.Schema.Create`），也可配 [Atlas](https://github.com/ariga/atlas) |
| 学习成本 | 低，约定式 | 生成物多一层，但 IDE 体验和重构安全性好 |

核心差异用两段代码对比更直观。GORM 用 struct tag 描述模型，查询时字段名是字符串：

```go
// GORM
type User struct {
    ID     uint   `gorm:"primaryKey"`
    Name   string `gorm:"size:64"`
    Status string `gorm:"index"`
    Tenant Tenant
}

db.Where("status = ?", "active").Find(&users)
```

ent 用 Go 代码声明 schema，查询是谓词/边方法，编译期可检查：

```go
// ent schema
func (User) Fields() []ent.Field {
    return []ent.Field{
        field.String("name").MaxLen(64),
        field.Enum("status").Values("active", "inactive"),
    }
}

func (User) Edges() []ent.Edge {
    return []ent.Edge{edge.To("tenant", Tenant.Type)}
}

// 查询
client.User.Query().
    Where(user.StatusEQ("active")).
    WithTenant().
    All(ctx)
```

落地后 ent 的形态是：schema 下用 Go 代码声明字段和边，通过 `go tool ent generate` 生成类型安全的访问代码；data（持久）层只持 `*ent.Client`，查询和 upsert 都用生成的链式 API，没有任何 SQL 字符串。

就表达风格而言，GORM 胜在直观简洁，ent 则把字段、索引、关联（`ent.Edge`）、校验等语义直接写进代码，编译期即可检查。选择 ent 的一部分原因，也是认同这种「schema 即代码」的表达方式。

### 3.2 枚举：proto 的 int32 与 ent 的 string

proto 的 enum 默认生成 int32（配合 `iota` 式的常量），ent 的 `field.Enum` 默认生成 string 枚举并做运行时校验。这会造成一个断层：传输层用数字表示状态，持久层用字符串表示状态。

两边的默认值各有道理：proto 侧 int32 紧凑、跨语言兼容性好；ent 侧 string 可读性强，直接看数据库就能知道状态含义。问题是传输层用数字、持久层用字符串，中间必须有一层转换。

建议把转换收敛在持久层（data/Repo 实现）统一处理：写入数据库前把业务枚举（int32）转成 ent 的 string 枚举，读出后再转回来。业务逻辑层（service/biz）只面对统一的业务枚举，持久化细节被隔离在持久层。

### 3.3 另一个观察

最初选 GORM 的理由只有「与 new-api 同栈」，但考察开源项目时注意到一组事实：Ory Kratos 用自研的 `ory/pop`，[Dex](https://github.com/dexidp/dex) 用 ent，ZITADEL 用 pgx，Hanko 用 pop——**头部项目的 ORM 各不相同，说明这一层选型更多是团队一致性问题而非技术优劣问题**。

另一个相关原则是数据库 schema 演进（迁移）最好与 ORM 解耦。这里的关键是控制粒度：用 [golang-migrate](https://github.com/golang-migrate/migrate) 管理版本化的 SQL 迁移文件（Ory Talos 也采用这个方案），可以对 DDL 做更细的控制和回滚；ent 自带的 `auto_migrate` 开关则让 ORM 自动推进 schema，更省事但可控性弱一些。两种方式都能走，关键是**只选一种权威来源**，避免混用。

## 4. HTTP/gRPC 的错误与响应信封

响应和错误怎么包装，是这次设计里比较特别的一项。HTTP 和 gRPC 两侧各有主流约定，最终采用的方案与两边都不完全一样。

### 4.1 三个生态的主流做法

**gRPC**：用一组固定的 status code（`OK`、`INVALID_ARGUMENT`、`NOT_FOUND`、`UNAUTHENTICATED` 等约 17 个）表达调用结果，错误详情走 `google.rpc.Status`（AIP-193）：`code` + `message` + `details`，`details` 是可扩展的结构化错误明细。gRPC-Gateway 默认把 status code 映射到对应的 HTTP 状态码（如 `NOT_FOUND` → 404）。

**Connect-RPC**：沿用与 gRPC 相同的 code 集合，但原生面向 HTTP/JSON，错误响应直接是 JSON。`code` 用字符串（如 `"not_found"`）而非数字；`details` 里的自定义错误用 base64 编码，避免客户端必须持有对应 proto 才能解析。与 gRPC-Gateway 相比，gRPC-Gateway 的 `code` 仍是数字（如 5）。二者共同点在于**传输层状态码负责错误分类，业务错误要归并到有限的 code 集合里**。

**REST/OpenAPI** 的主流则是「HTTP 状态码即业务结果」：2xx 成功、4xx 客户端错误、5xx 服务端错误，业务错误类别多时再在 body 里套一层 `code`/`message`。好处是基础设施（LB、WAF、CDN、APM）都能识别，前端 `response.ok` 直接可用。

三种做法的响应示例对比：

```json
// gRPC-Gateway 成功响应（HTTP 200）
{
  "id": "sess_xxx",
  "name": "..."
}

// gRPC-Gateway 错误响应（HTTP 404）
{
  "code": 5,
  "message": "session not found",
  "details": []
}
```

```json
// Connect-RPC 成功响应（HTTP 200）
{
  "id": "sess_xxx",
  "name": "..."
}

// Connect-RPC 错误响应（HTTP 404）
{
  "code": "not_found",
  "message": "session not found",
  "details": []
}
```

```json
// REST/OpenAPI 成功响应（HTTP 200）
{
  "id": "sess_xxx",
  "name": "..."
}

// REST/OpenAPI 错误响应（HTTP 404）
{
  "error_code": "SESSION_NOT_FOUND",
  "message": "session not found"
}
```

### 4.2 本方案的信封形式

这次设计实际采用的是**全平台统一业务信封 + HTTP 状态码恒为 200**：

- 所有 RPC 响应统一为 `{ retcode, retmsg, data }`；`retcode=0` 表示成功，非 0 为业务错误码，按 HTTP 风格分段：`400xx` 参数错误、`401xx` 认证失败、`403xx` 授权失败、`404xx` 不存在、`409xx` 冲突、`500xx`/`503xx` 内部错误/不可用；api-server 自身的转发/中间件层错误用 `900xx` 段位。
- 信封定义在 proto message 层：每个 `XxxResponse` 含 `retcode`/`retmsg`/`data` 字段，原业务字段下沉为 `XxxResponseData`。这样 gRPC 与 HTTP/JSON 共享同一结构，gRPC status 只保留传输语义（调用是否到达、是否 panic），不再承载业务错误。

示例：

```proto
// proto 层定义的信封
service SessionService {
  rpc GetSession(GetSessionRequest) returns (GetSessionResponse);
}

message GetSessionRequest {
  string id = 1;
}

message GetSessionResponse {
  int32  retcode = 1;
  string retmsg  = 2;
  GetSessionResponseData data = 3;
}

message GetSessionResponseData {
  string id   = 1;
  string name = 2;
}
```

```json
// 成功
{
  "retcode": 0,
  "retmsg": "ok",
  "data": { "id": "sess_xxx", "name": "..." }
}

// 业务错误
{
  "retcode": 40101,
  "retmsg": "token expired",
  "data": null
}
```

### 4.3 这样设计的好处

- **前端契约稳定**：调用方只看 `retcode`，不需要同时理解 HTTP 状态码和 connect/gRPC 错误体两套约定。
- **多下游混用时不被牵制**：不会因为某个下游返回 500 就让前端把整条链路当服务器故障；部分下游失败时，网关可以用自己的 `900xx` 表达「下游异常响应」，而不是被 gRPC status 限制。
- **错误码空间可扩展**：gRPC 的 17 个 code 对业务来说太粗，数字 code 的可读性也差；HTTP 风格段位兼顾了分类能力和可读性。

### 4.4 代价同样明显

- **HTTP 状态码失去区分能力**：负载均衡、缓存、WAF、APM 无法通过状态码区分成功与失败；如果未来对外开放或接入第三方 SDK，「200 包错误」会让标准客户端困惑。
- **可观测性需要额外建设**：access log 只记 `http_status=200` 的话，SRE 会以为一切正常。必须把 `retcode`（和 RPC 方法标识）作为 access log、trace、metrics 的一级字段，对 `retcode != 0` 的 span 标记 error，告警按「方法 + retcode」配置而不是只看 5xx。

几个前提同时成立时，这个方案才干净：所有下游统一了信封格式、网关保持轻量（不深入业务语义）、前端是内部团队，可以接受「看 retcode 不看 status」的约定。前提一旦变化（比如开放给外部开发者），矛盾会首先集中在 HTTP 语义缺失这一侧。

## 5. gin / chi / echo / kratos protoc-gen-go-http

在 proto-first 架构下，HTTP 框架不再承载业务语义，只是生成 handler 或网关路由的运行载体。选型标准因此也和传统 Web 项目不同。

### 5.1 chi：api-server 的最外层路由

api-server 需要的是一个能和 gRPC-Gateway 无缝配合的路由层。选 [chi](https://github.com/go-chi/chi)，关键原因是它只聚焦「路由 + 中间件」，不引入额外的请求模型：

- chi 基于标准 `net/http`，中间件签名是 `func(http.Handler) http.Handler`，可以直接挂载 gRPC-Gateway 生成的 `http.Handler`；
- [Gin](https://github.com/gin-gonic/gin) 是一整套 Web 框架，有自己的上下文、绑定、渲染、验证和错误处理模型，会与 gRPC-Gateway 的 `runtime.ServeMux` 以及统一信封模型形成**两套语义**；
- 这个项目不需要 Gin 的模板、表单绑定、验证等能力，chi 的路由能力足够覆盖 gateway、health、OpenAPI、Custom Handler 几个入口。

这样业务语义全在 gRPC/信封一侧，HTTP 层只保留 `net/http` 外层路由即可，不需要维护第二套请求和错误模型。

### 5.2 Gin：在 authx 里被收窄到 HTTP-only 端点

authx 对 Web 框架的需求比网关更窄。原设计里选了 [Gin](https://github.com/gin-gonic/gin)，理由同样是「与 new-api 同栈」，但职责被刻意收窄：只承载 OAuth callback、JWKS、well-known 这几个 HTTP-only 端点的路由和中间件（CORS、Recovery、访问日志），connect handler 用 `gin.WrapH` 挂进来共用端口。这些端点后来都委托给了 api-server，Gin 在 authx 里也就失去了存在必要。

### 5.3 echo 为什么没成为候选

[echo](https://github.com/labstack/echo) 在两个项目里都没有成为候选，只在考察开源实现时遇到过（[Hanko](https://github.com/teamhanko/hanko) 用 `labstack/echo/v4`）。echo 比 Gin 内置能力更多，但也更重；而 Gin 在国内更流行，且已有项目已经采用 Gin。在 proto-first 架构下，echo 没有额外优势。

### 5.4 kratos protoc-gen-go-http：不是同一个维度

kratos 自带的 `protoc-gen-go-http` 属于另一个类别：它不是候选框架，而是 HTTP 代码生成器。它从 `google.api.http` 注解生成 HTTP handler，把 HTTP query/path/body 绑定到 proto 请求消息，调用 service 接口方法，再把 proto 响应写回 HTTP/JSON。这样 HTTP server 和 gRPC server 可以跑在同一个服务里，共享同一份 service 实现。

它和 gRPC-Gateway、Connect-RPC 都在做「HTTP/JSON → gRPC」，但定位不同：

- **gRPC-Gateway** 是独立网关，通常单独部署，适合管理面网关这类需要集中控制的场景；
- **Connect-RPC** 是协议框架，路径约定式，同时支持 Connect/gRPC/gRPC-Web；
- **kratos `protoc-gen-go-http`** 是进程内代码生成，按 `google.api.http` 注解把已有 gRPC 服务再暴露一层 HTTP，服务仍然是 gRPC 优先。

所以 api-server 作为管理面网关选 gRPC-Gateway；独立服务需要多协议暴露时 Connect-RPC 更轻量；kratos 服务内部需要 HTTP 时，`protoc-gen-go-http` 就能满足需求。

| | gRPC-Gateway | Connect-RPC | kratos `protoc-gen-go-http` |
|---|---|---|---|
| 定位 | 独立 HTTP/JSON → gRPC 网关 | 多协议 RPC 框架 | kratos 进程内 HTTP 代码生成 |
| 部署 | 单独进程/服务 | 与业务服务同进程 | 与业务服务同进程 |
| HTTP 路径 | `google.api.http` 注解 | 约定式 `/{pkg}.{Service}/{Method}` | `google.api.http` 注解 |
| 协议支持 | HTTP/JSON ↔ gRPC | Connect/gRPC/gRPC-Web | HTTP/JSON ↔ gRPC |
| 主要场景 | 管理面网关、公共 HTTP 契约 | 独立服务多协议暴露 | kratos 服务内部暴露 HTTP |

## 6. go-kratos 生态的默认技术栈与分层

authx 的实施阶段由 leader 指定了 [go-kratos](https://github.com/go-kratos/kratos) 生态。实际代码基于 go-kratos v3 的 kratos-layout 模板做了些改造，从中可以看出这个生态的默认主张。

很多读者熟悉的 go-kratos 是 v2 系列，[v3.0.0 发布于 2026 年 6 月](https://github.com/go-kratos/kratos/releases/tag/v3.0.0)，最大的变化是模块路径整体迁入 `/v3`（破坏性变更），要求 Go 1.25+；跟进的改进包括 errors 包增加标准库 `errors` 的包装、logging 中间件转向标准库 `slog`、config 增加泛型 `Get`、validate 支持自定义 validator 等。实际使用下来，模板结构与 v2 差别不大。

### 6.1 推荐的层次划分

```text
services/auth/
├── cmd/auth/            # main.go + wire.go + wire_gen.go，唯一的依赖注入装配点
├── configs/             # config.yaml
└── internal/
    ├── conf/            # conf.proto 定义 AppConfig，buf 生成 conf.pb.go
    ├── server/          # grpc.go / http.go，装配 kratos 的 gRPC/HTTP server 并注册 service
    ├── service/         # DTO↔DO 转换，填统一响应信封，实现 proto 生成的 Service 接口
    ├── biz/             # 业务/领域逻辑（biz）：DO（纯领域对象）+ Repo 接口 + Usecase，类型化错误
    ├── data/            # 持久层（data）：Repo 接口的实现，DO↔PO 转换，持有 *ent.Client
    └── pkg/             # 共享工具
```

分层契约的核心是 **DTO/DO/PO 三模型 + 单向依赖**：

- `service` 只做 DTO（proto 消息）↔ DO 转换，**不允许 import data**；
- `biz` 是纯领域逻辑（业务层），Repo 接口在这里声明；
- `data` 实现 Repo 接口（持久层），负责 DO↔PO 转换——构造函数返回接口类型（`func NewUserRepo(data *Data) biz.UserRepo`），由 wire 完成注入；
- 生成物（`*.pb.go`、`wire_gen.go`、ent 产物）不做手工修改，统一用 `make api` / `make generate` 重新生成。

### 6.2 默认技术栈的形态

| 能力 | 机制 |
|---|---|
| 生命周期 | `kratos.New(kratos.Server(gs, hs))`，gRPC/HTTP server 统一管理启停 |
| 配置 | proto 定义配置结构（`AppConfig`），buf 生成代码，kratos config 从文件加载并扫描进结构体 |
| 依赖注入 | [google/wire](https://github.com/google/wire)，各层暴露 `ProviderSet`，cmd 是唯一装配点 |
| 错误 | kratos `errors` 的类型化错误（NotFound 等），配合自定义信封 retcode/retmsg |
| 中间件 | recovery、validate（实际用的是 [`go.einride.tech/aip`](https://github.com/einride/aip-go) 的 field behavior 校验）等，按 server 维度挂载 |
| proto 工具链 | [buf](https://github.com/bufbuild/buf) v2（lint STANDARD + breaking）+ `protoc-gen-go` / `-go-grpc` / `-go-http` / `protoc-gen-openapi` |
| 工具管理 | Go 1.24+ 的 `tool` 指令统一由 go.mod 管理，`go tool buf` / `go tool wire` / `go tool ent`，不再 `go install` |
| API 风格 | 遵循 Google AIP：resource-oriented、`page_size`/`page_token` 分页、field behavior、Protovalidate 校验规则写在 proto 里 |

相对标准模板，实际落地时做了几处裁剪：业务接口只走 gRPC 暴露，HTTP server 仅保留健康检查；响应统一用信封而非 kratos 默认错误透传。

## 7. Session Token 的形态：JWT vs 随机字符串

authx 设计阶段还有一个讨论较多的问题：session token 该用什么形态。

前提是一个经常被忽略的事实：AuthX 本来就有后端状态（`sessions` 表 + Redis），而且凭证校验被要求**必须实时回源**——`IntrospectionService/Introspect` 每次都要确认凭证有效、未被吊销。这样一来，JWT 赖以成名的「免回源」优势就发挥不出来了：验证 access_token 时仍然要查后端的用户、角色和吊销状态。

两种纯粹的形态各有明确的适用面：

- **随机字符串（opaque token）**：本身不携带任何语义，校验必须回源；回源开销与现状一致，但吊销即时生效，没有传播延迟，校验逻辑也最简单。Session Cookie、API Key（`sk-xxx`）本质上都是这一类。
- **自包含 JWT**：声明（`user_id`、`tenant_id`、`role_ids`）内含在 token 里，短 TTL（如 5-15 分钟）可以减少回源次数；代价是吊销只能靠黑名单或等待过期，「自包含」和「可吊销」天然矛盾。

合理的做法是按场景区分，**两种方案不宜拼在一起**：JWT + 回源黑名单的混合形态同时承担了两边的成本——既没有纯 JWT 的免回源，也没有 opaque token 的吊销简单，还要额外维护黑名单存储和 jti 管理。不过这个方向 leader 已经定了，目前采用的正是这种混合形态：JWT access token + refresh token，配 Redis 黑名单支持强制下线。

## 8. 收尾

把两个项目的结论放在一起对照：

| 主题 | api-server（管理面网关） | authx（独立认证服务） |
|---|---|---|
| RPC 方案 | gRPC + gRPC-Gateway，不引入 Connect-RPC | 原设计 connect-go，演进后转向 grpc-go（见 1.4） |
| HTTP 路由 | chi（与生成物中间件模型兼容） | 原设计 Gin，HTTP-only 端点后委托给 api-server |
| ORM | —（不直接访问数据库） | 最初定 GORM，go-kratos 实施后落地 ent |
| OpenAPI | 四候选中 gnostic / connect-openapi 二选一待定，后处理合并必备 | —（由 api-server 统一发布 OpenAPI v3） |
| 响应信封 | 透传下游信封，自身错误用 `900xx` | 统一 `{retcode, retmsg, data}` 信封，HTTP 恒 200 |

技术选型很少有绝对的优劣之分，更多取决于「这个角色需要什么」和「团队已经有什么」。工作暂停于此，记录留档，后续如果重启，这份对照应该还能直接用。
