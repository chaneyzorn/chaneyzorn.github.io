---
title: "HTTP Cookies 安全性与 TLS 证书配置"
date: 2024-12-31T14:30:00+08:00
isCJKLanguage: true
draft: false
tags: ["HTTP", "HTTPS", "Cookie", "api-gateway", "TLS", "Certificate", "encryption"]
---

## 背景

书接[上回](../adguard-dns-systemd-resolved/)，我将一些服务经过 API gateway 统一代理之后，便可以省略端口仅使用自定义域名来访问这些服务了。但是当我使用 Chrome 打开 `http://pve.home.lan/` 页面并输入账号密码之后，PVE 页面却报出 `Connection error 401: No ticket`。

![PVE 401](./asserts/http-401-no-ticket.png#center)

在反复对比协议、端口、Headers、Token 等请求参数之后，我发现当使用 HTTP 访问 PVE 页面时，浏览器发出的请求总是会“遗漏” Cookies 信息，而使用 HTTPS 时却可以正常的携带 Cookies 信息。

![HTTP 不发送 Cookies](./asserts/http-cookie-lost.svg#center)

我推测正是因为这个差异导致了登录失败。

## Cookies 的 Secure 属性

网上查询 Cookies 在 HTTP 和 HTTPS 上的差异之后，我在 MDN 上确认了 Cookies 的 `Secure` 属性——**被标记为 `Secure` 的 Cookies 只能在 HTTPS 上发送**：

> **Secure**: All cookies must be set with the Secure directive, indicating that they should only be sent over HTTPS.[^mdn-secure-cookies]

[^mdn-secure-cookies]: [Secure cookie configuration - Security on the web | MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies#secure)

通过 Chrome 的 `DevTools - Application - Cookies` 查看 Cookies 信息，可以明确看到名称为 `PVEAuthCookie` 的 Cookie 是标记为 `Secure` 的：

![DevTools Cookies Secure](./asserts/devtools-cookie-secure.png#center)

查看 pve-manager 的源代码，也可以确认 Cookie 是主动标记为 `Secure` 的[^pve-manager-wiget]：

![pve-manager 设置 Cookies 为 Secure](./asserts/pve-manager-cookies-set-secure.png#center)

[^pve-manager-wiget]: [pve-manager/www/mobile/WidgetToolkitUtils.js at master · proxmox/pve-manager](https://github.com/proxmox/pve-manager/blob/master/www/mobile/WidgetToolkitUtils.js)

> Specify `true` to indicate that the cookie should only be accessible via SSL on a page using the HTTPS protocol.[^pve-manager-set-cookie]

![pve-manager 的 Ext.util.Cookies](./asserts/pve-manager-util-cookies.png#center)

[^pve-manager-set-cookie]: [pve-manager/www/mobile/Cookies.js at master · proxmox/pve-manager](https://github.com/proxmox/pve-manager/blob/master/www/mobile/Cookies.js)

具体的设置方式，简化后只有一行代码：

```js
document.cookie = `${name}=${value};secure`
```

为了正常使用 PVE，目前看来我需要为 API gateway 配置上 TLS 证书了，这样我才能通过 HTTPS 来访问它。那么——

## TLS 证书包含哪些文件，有什么作用呢？

### 对称加密与非对称加密

TLS 协议的核心是`对称加密`和`非对称加密`：

- **对称加密**：
  - 数据使用密钥进行加密，加密后的数据使用同一密钥进行解密；
  - 密钥不应暴露，否则加密的信息会泄密；
  - 加密和解密所需计算开销较小；
- **非对称加密**：
  - 使用**私钥**加密的数据只能通过**公钥**解密，反之亦然；
  - 公钥可以公开，私钥不应暴露；使用公钥可以解密数据，并同时证明数据来自私钥所有者；
  - 加密和解密所需计算开销较大；

由于`非对称加密`所需计算开销较大，因此在 HTTPS 中`非对称加密`主要用于加密`对称加密`的密钥，而主体数据使用`对称加密`。

### 存放公钥和私钥——`.pem` 格式文件

虽然证书等相关文件的称谓很多，比如：公钥、私钥、证书签名请求文件、证书文件、证书链文件、对称加密密钥文件等，但它们都可以选择使用 `.pem` 格式记录内容，形式如下（包含一条或多条记录）：

```pem
-----BEGIN <Type>-----
<Base64 Encoded Content>
-----END <Type>-----
-----BEGIN <Type>-----
<Base64 Encoded Content>
-----END <Type>-----
```

这些文件的具体命名各式各样，有些会带上 `.pem` 后缀，而有些不会。对于仅使用 `.pem` 作为后缀的文件，也可能无法通过这个后缀来断定文件的具体类型。对于这样的文件，我们可以通过上述文件内容中的 `<Type>` 来确认具体类型，比如：

- `CERTIFICATE`：证书，包含所有者的信息、公钥，以及签名；
- `OPENSSH PRIVATE KEY`：openssh 私钥；
- `ENCRYPTED PRIVATE KEY`：使用口令进行过一次对称加密的私钥；
- `CERTIFICATE REQUEST`：证书签名请求文件，包含请求方信息和请求方公钥；

### 证书文件包含的信息和作用

![CA 和服务器证书在 HTTPS 中的作用](./asserts/https-ca-cert.svg#center)

上图是浏览器与服务器进行 HTTPS 通信的示意图，其中涉及到的证书文件如下：

- **服务器私钥（`server.key`）**：非对称加密时使用的私钥，加密&解密 HTTPS 数据。不对外公开。
- **服务器证书（`server.crt`）**：包含有三部分信息：a. 域名、签发机构、有效时间等信息；b. 非对称加密时使用的公钥；c. 上级签发机构的私钥对本服务器公钥进行加密后的签名。当浏览器请求 TLS 握手时，提供给浏览器以验证签名信息，以及用于后续**密钥交换算法**的加密。对外公开。
- **CA 私钥（`ca.key`）**：证书签发机构（Certificate Authority）对下级机构的证书签名请求（CSR - Certificate Signing Request：域名等信息+下级机构的公钥）进行签名时使用的私钥。不对外公开。
- **CA 证书（`ca.crt`）**：类似于服务器证书，包含 CA 的公钥信息，可用于解密私钥的签名。根 CA 证书预先内置于浏览器中，供浏览器验证目标服务器证书的签名，**确保服务器证书的所有者正是域名&服务器的所有者**。根 CA 的证书一般不再有更上级的机构为其签名，因此根 CA 的证书是使用自己的私钥进行签名的**自签名证书**。对外公开。

HTTPS 详细背景和科普可以参考 Youtube 上的《HTTPS, SSL, TLS & Certificate Authority Explained》[^youtube-https-explain]。

[^youtube-https-explain]: [HTTPS, SSL, TLS & Certificate Authority Explained - YouTube](https://www.youtube.com/watch?v=EnY6fSng3Ew)

浏览器与服务器的 TLS 握手流程可以参考 Youtube 上的 《TLS Handshake - EVERYTHING that happens when you visit an HTTPS website》[^youtube-tls-handshake]。

[^youtube-tls-handshake]: [TLS Handshake - EVERYTHING that happens when you visit an HTTPS website - YouTube](https://www.youtube.com/watch?v=ZkL10eoG1PY)

## 生成证书文件

这里我们所需的是，API gateway 提供 HTTPS 访问时需要用到的服务器私钥和证书。

### 通过权威 CA 签发证书

只有被浏览器信任的 CA 所签发的服务器证书，才不会被浏览器提示安全问题，因为这些证书的签名可以被预先内置于浏览器的根 CA 证书所验证。这是推荐使用的方法。

CA 签发证书不是无条件的，只有使用某种方式向 CA 证明自己是目标域名&服务器的所有者，CA 才会授予签名后的证书。大致有如下几种方式：

- 在域名的目标服务器的公开访问路径下，放置 CA 指定的特定文件，供 CA 访问并核对内容，以证明自己是服务器的所有者；
- 在公共 DNS 解析服务上，创建 CA 指定的域名解析记录，比如想要签发的域名为 `example.com`，则需要创建的 DNS 记录可能形如 `acme-challenge.example.com`，并被 DNS 解析为 CA 指定的文本内容（Text Record），以证明自己是域名的所有者；

使用 CA 签发的服务器证书的好处：

1. 不会被浏览器提示安全问题；
2. 经由 CA 签名的证书，可以确认证书的所有者就是服务器和域名的所有者，用户不用担心中间人攻击；

### 自签名证书

通过权威 CA 签发证书有一定的门槛：

1. 需要有一个能够被公开访问的服务器，或能够被公开访问的域名；
2. 需要一个和互联网连通的网络环境；
3. CA 签发的证书的有效时限相对较短，需要定期更新（但也确保了安全性）；

我目前尚未注册任何公开访问的域名。符合心意且未被注册的域名一般都比较昂贵，也很难和我之前的自定义域名相匹配，因此我选择自己生成证书文件——这也意味着这个证书将不会得到权威 CA 的背书。

假如我们要签发的域名是 `*.home.lan`，以下步骤参考自 internal-contstrained-pki[^internal-contstrained-pki]，它的特点是限定了生成的 CA 证书只能用于特定域名范围的签发和验证（`nameConstraints`），它也提供了一些参考文档[^name-contstraints]。

[^internal-contstrained-pki]: [nh2/internal-contstrained-pki: Safely shareable TLS root CA for .internal networks using Name Constraints](https://github.com/nh2/internal-contstrained-pki)

[^name-contstraints]: [Private CA with X.509 Name Constraints | System Overlord](https://systemoverlord.com/2020/06/14/private-ca-with-x-509-name-constraints.html)

生成 CA 密钥 `ca-home.lan.key`：

```sh
openssl genrsa -out ca-home.lan.key 4096
```

生成 CA 证书 `ca-home.lan.crt`：

```sh
# 生成证书签名请求文件（CSR - Certificate Signing Request）
openssl req -new \
    -key ca-home.lan.key \
    -batch -out ca-home.lan.csr \
    -utf8 -subj "/O=InternalCA"

# 使用了 `nameConstraints` 选项来限定这个 CA 证书只能被用于 `*.home.lan` 域名的签发
cat << EOF > ca-ext-home.lan.ini
basicConstraints     = critical, CA:TRUE
keyUsage             = critical, keyCertSign, cRLSign
subjectKeyIdentifier  = hash
nameConstraints      = critical, permitted;DNS:home.lan , permitted;DNS:.home.lan
EOF

# 使用上一步中的 CA 私钥进行自签名
openssl x509 -req -sha256 \
    -days 1800 \
    -in ca-home.lan.csr \
    -signkey ca-home.lan.key \
    -extfile ca-ext-home.lan.ini \
    -out ca-home.lan.crt

# 准备一个服务器证书编号
echo 1000 > ca-home.lan.srl
```

生成服务器密钥 `wildcard.home.lan.key`：

```sh
openssl genrsa -out wildcard.home.lan.key 2048
```

生成服务器证书 `wildcard.home.lan.crt`：

```sh
openssl req -new \
    -key wildcard.home.lan.key \
    -batch -out wildcard.home.lan.csr \
    -utf8 -subj "/CN=*.home.lan"

cat << EOF > cert-ext-wildcard.home.lan.ini
basicConstraints        = critical, CA:FALSE
subjectKeyIdentifier     = hash
authorityKeyIdentifier   = keyid:always
nsCertType              = server
authorityKeyIdentifier   = keyid, issuer:always
keyUsage                = critical, digitalSignature, keyEncipherment
extendedKeyUsage        = serverAuth
subjectAltName          = DNS:home.lan,DNS:*.home.lan
EOF

openssl x509 -req -sha256 \
    -days 1800 \
    -in wildcard.home.lan.csr \
    -CAkey ca-home.lan.key \
    -CA ca-home.lan.crt \
    -CAserial ca-home.lan.srl \
    -out wildcard.home.lan.crt \
    -extfile cert-ext-wildcard.home.lan.ini
```

使用 CA 证书验证服务器证书是否正确：

```sh
openssl verify -CAfile ca-home.lan.crt wildcard.home.lan.crt
```

各个文件的用途和使用方式：

- `ca-home.lan.key`：秘密保存，用于之后签发新的服务器证书；
- `ca-home.lan.crt`：CA 自签名证书，可以作为根证书导入到浏览器中，以验证并信任签发的服务器证书；
- `wildcard.home.lan.key`：秘密保存，放置于域名对应的服务器上（我这里是 API gateway），在 TLS 握手时会被使用；
- `wildcard.home.lan.crt`：放置于域名对应的服务器上，在 TLS 握手时会被发送给浏览器客户端；

## 解决 PVE 页面登录问题

将上述服务器证书配置于 API gateway 中，并启用 `443` 端口代理即可[^kong-proxy-listen]。我使用的 API gateway 是 Kong（基于 nginx），类似的服务还有 caddy，配置方式需参考具体服务的官方文档。

```sh
KONG_PROXY_LISTEN="0.0.0.0:80, 0.0.0.0:443 ssl"
```

[^kong-proxy-listen]: [Configuration Reference for Kong Gateway - v3.9.x proxy_listen | Kong Docs](https://docs.konghq.com/gateway/3.9.x/reference/configuration/#proxy_listen)

![Kong 证书配置](./asserts/kong-cert-config.png#center)
![Kong 证书填写](./asserts/kong-cert-fill.png#center)

### 什么是 SNI？

我在 Kong Manager 的配置界面上发现了 SNIs 这个选项，它是什么含义呢？Cloudflare 解释如下[^cloudflare-sni]：

> 当多个网站托管在一台服务器上并共享一个 IP 地址，并且每个网站都有自己的SSL证书，在客户端设备尝试安全地连接到其中一个网站时，服务器可能不知道显示哪个SSL证书。这是因为SSL/TLS握手发生在客户端设备通过HTTP指示连接到某个网站之前。
>
> 服务器名称指示 (SNI) 旨在解决此问题。SNI 是 TLS 协议（以前称为 SSL 协议）的扩展，该协议在 HTTPS 中使用。它包含在 TLS/SSL 握手流程中，以确保客户端设备能够看到他们尝试访问的网站的正确 SSL 证书。该扩展使得可以在 TLS 握手期间指定网站的主机名或域名 ，而不是在握手之后打开 HTTP 连接时指定。

[^cloudflare-sni]: [什么是SNI？TLS服务器名称指示如何工作 | Cloudflare](https://www.cloudflare-cn.com/learning/ssl/what-is-sni/)

### 浏览器导入根证书

当使用浏览器打开 HTTPS 页面时，如果不是可信 CA 签发的证书，则会提示报错 `net::ERR_CERT_AUTHORITY_INVALID`：

![浏览器提示 ERR_CERT_AUTHORITY_INVALID](./asserts/browser-err-cert.png#center)

即使在这个首页点击“高级-继续前往”，也无法避免某些非首页请求（可能是非标准 443 端口）时发生的间接 `ERR_CERT_AUTHORITY_INVALID` 报错情况。这种情况需要在地址栏输入请求链接并手工确认继续前往，方式十分隐晦，对用户不太友好：

![DevTools 报错 ERR_CERT_AUTHORITY_INVALID](./asserts/devtools-err-cert.png#center)

对于这样的情况，我们可以将前面生成的 CA 证书（`ca-home.lan.crt`）导入到浏览器中，不同的操作系统的操作方式各不相同，macOS 平台上的操作如下：

"设置-隐私和安全-安全-管理证书-管理从 MacOS 导入的证书-打开钥匙串访问"，解锁“系统”钥匙串，将证书拖入其中，并标记为信任：

![macOS 钥匙串](./asserts/macos-keyring.png#center)
![macOS 标记信任证书](./asserts/macos-set-cert-trust.png#center)

重新锁定“系统”钥匙串，并刷新浏览器页面即可生效。

### noVNC 界面也可以正常访问

我并没有在 Kong API gateway 上为代理目标开放更多协议和端口，但我发现使用 `websocket` 协议的 noVNC 的界面也是可以正常访问的。由于 `websocket` 的 url 类似于 `wss://`，我之前一直以为它是平行于 `http://` 的独立协议。现在我仅能推测，在本场景中，它和 http/https 使用相同的端口传输数据。

不过本篇文章就到此为止了，关于 `websocket` 协议的细节，后面若有机会遇到再作详细展开。

在切换为 HTTPS 访问 PVE 之后，页面终于可以正常打开了。

![使用 https 访问 API gateway](./asserts/https-api-gateway.svg#center)

## 参考文档
