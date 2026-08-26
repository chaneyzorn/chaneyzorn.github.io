---
title: "AdGuard DNS 与 systemd-resolved"
date: 2024-12-24T14:37:03+08:00
isCJKLanguage: true
draft: false
tags: ["systemd", "systemd-resolved", "adguard", "adguard-home", "DNS", "mDNS", "selfhosted", "gethostbyname"]
cover:
    image: "asserts/systemd-logo.svg"
    relative: true
---

我在家中使用零刻和树莓派自托管一些服务之后，想通过自定义域名（比如`pve.home.io`）的方式来访问这些服务，这样就可以避免记忆哪些服务在哪些节点上（以及对应的端口是什么）。

具体的做法是，将自定义的域名统一解析到 API Gateway 的 IP 地址上，然后使用 Gateway 的路由功能，根据请求中的具体域名，将请求代理到对应的节点和端口上：

![域名至对应服务](./asserts/dns-api-gateway.svg#center)

我使用的 DNS 服务是 [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)，它默认监听在 `0.0.0.0:53/udp` 上，但是在使用 systemd 系列组件的节点上，systemd-resolved 会监听在 `127.0.0.53:53/dup` 上，因此会导致端口冲突。AdGuard [官方 wiki 给出的解决方式](https://github.com/AdguardTeam/AdGuardHome/wiki/Docker#resolved)是修改 resolved 的配置，停止监听 `127.0.0.53:53`。

```sh {hl_lines=[3,4]}
$ sudo netstat -uanp
Proto Recv-Q Send-Q Local Address           Foreign Address  PID/Program name
udp        0      0 127.0.0.54:53           0.0.0.0:*        431/systemd-resolve
udp        0      0 127.0.0.53:53           0.0.0.0:*        431/systemd-resolve
udp        0      0 192.168.0.2:68          0.0.0.0:*        359/systemd-network
udp        0      0 0.0.0.0:5353            0.0.0.0:*        431/systemd-resolve
udp        0      0 0.0.0.0:5355            0.0.0.0:*        431/systemd-resolve
udp6       0      0 fe80::be24:11ff:fe1:546 :::*             359/systemd-network
udp6       0      0 :::5353                 :::*             431/systemd-resolve
udp6       0      0 :::5355                 :::*             431/systemd-resolve
```

但如果希望避免侵入系统默认的运维配置，就需要另一种方案。

> **更新（2026-08-26）**：补充 Ubuntu 24.04 Server 上 `systemd-resolved` 与 `libnss-resolve` 的差异，以及开启 mDNS 的完整配置条件。详见后文「Ubuntu 24.04 上开启 mDNS 的完整条件」一节。

要找到不侵入系统默认配置的替代方案，需要先理解 systemd-resolved 实际在做什么。

## 1. systemd-resolved 的作用

resolved 对运行在本地的应用程序提供了一个 DNS 中间层，这个中间层的作用是（[参考：systemd-resolved(8)](https://man.archlinux.org/man/systemd-resolved.8)）：

1. 对上游的 DNS 记录进行缓存，在网络配置发生变化时自动刷新缓存；
2. 对上游的 DNSSEC 进行验证；
3. 支持将来自本地的 DNS 请求转换为 DoT 发送给上游（暂不支持 DoH，见 [issue #8639](https://github.com/systemd/systemd/issues/8639)）；
4. 提供 mDNS 和 LLMNR 服务，以及 link-local 地址反向查找设备名；
5. 提供本地特定别名的地址解析，比如：`<hostname>`、`localhost`、`*.localhost`、`_gateway`、`_outbound`，以及在 `/etc/hosts` 中的映射；

### 1.1 相关术语解释

- **DNS**：将域名转换为对应的 IP 地址；
- **DNSSEC**：服务方在 DNS 响应中加上私钥签名，接收方使用公钥验证签名以确保服务方的真实性；
- **DoT**：DNS over TLS，客户端与 DNS 服务端使用 TLS 加密连接来传输查询和响应；
- **DoH**：DNS over HTTPS，客户端与 DNS 服务端使用 HTTPS 协议来传输查询和响应；
- **mDNS**：MulticastDNS，一种用于局域网中设备相互发现的去中心式的协议。传统 DNS 是中心式的，且域名和地址间的映射相对固定，无法及时反映局域网中设备加入和离开（且 IP 地址可能会被随机分配）的场景。mDNS 可以让这些设备方便地互相找到并通信，而不需要复杂的 DNS 配置。比如直接使用 `<hostname>.local` 来访问局域网中对应的 `<hostname>` 节点，而无需预先知道该节点的 IP 地址并手动进行 DNS 配置。
- **LLMNR**：和 mDNS 类似，主要流行于 windows 系统，可以使用类似 `MY-OFFICE-PC` 的名称来访问局域网中的设备；
- **link-local addresses**：仅用于局域网中**单个网段**内部通讯的地址，当无 DHCP 可用时设备可能会自动随机生成一个这样的本地地址。IPv4 地址范围是 `169.254.0.0 - 169.254.255.255`，IPv6 地址范围是 `fe80::/10`。虽然 IPv4 本地地址一般仅在没有 DHCP 时才会被自动生成(或被手动配置)，但当 IPv6 可用时，IPv6 本地地址却总是自动生成并一直存在的（[参考：Link-local address](https://www.wikiwand.com/en/articles/Link-local_address)）。

`fe80` 正是这类地址的典型前缀：

```sh
$ ip a | grep "scope link"
    inet6 fe80::be24:11ff:fe17:ef6c/64 scope link proto kernel_ll
    inet6 fe80::42:6aff:fe71:bd0e/64 scope link proto kernel_ll
```

## 2. systemd-resolved 提供的接口形式

resolved 使用以下几种接口对本地应用程序提供服务（[参考：systemd-resolved(8)](https://man.archlinux.org/man/systemd-resolved.8)）：

1. D-Bus 接口 [`org.freedesktop.resolve1`](https://man.archlinux.org/man/org.freedesktop.resolve1.5.en)；
2. UNIX socket `/run/systemd/resolve/io.systemd.Resolve`；
3. glibc 的 [`getaddrinfo`](https://man.archlinux.org/man/getaddrinfo.3.en) 等相关函数（通过使用 [`nss-resolve`](https://man.archlinux.org/man/nss-resolve.8.en) 模块）;
4. DNSStubListener：使用传统的 DNS 访问 `127.0.0.53:53` 和 `127.0.0.54:53`，涵盖 UDP 和 TCP；

另外 resolved 还提供了本节点在局域网中的 mDNS 和 LLMNR 服务：

- mDNS：监听在 `0.0.0.0:5353/udp`；
- LLMNR：监听在 `0.0.0.0:5355`，涵盖 UDP 和 TCP；

![本地应用使用 resolved](./asserts/app-resolved.svg#center)

注意上图中标注的网络范围。各个接口的使用方式各不相同，且支持的特性也存在差异，更多信息请参考 [man page](https://man.archlinux.org/man/systemd-resolved.8) 和 [systemd 官方相关文档](https://systemd.io/WRITING_RESOLVER_CLIENTS/)。

## 3. 127.0.0.53:53 和 127.0.0.54:53 有什么区别？

文章开头的 UDP 端口列表中，不仅存在 `127.0.0.53:53`，还存在一个 `127.0.0.54:53`。这两个本地 53 端口监听分别承担什么功能？它们的区别是什么？

如上文中介绍的，对于使用 mDNS 和 LLMNR 的局域网设备，它们的名称和 IP 地址的映射并不是由中心化的 DNS 服务器管理的，所使用的协议也不是监听在 53 端口的传统 DNS 协议，因此对于这些特殊的设备名查询 IP 地址并不能走传统的 DNS 协议。

resolved 作为中间层增加了对 mDNS 和 LLMNR 的支持，因此可以将局域网设备名解析为 IP 地址。这一功能无法架设在传统 DNS 协议之上，但将解析结果暴露在 DNS 接口中是可行的，这就是 `127.0.0.53:53` 额外提供的能力。该地址还会提供 DNSSEC 校验。

而 `127.0.0.54:53` 仅是上游 DNS 服务器的转发代理，它既不提供 mDNS 和 LLMNR 查询结果，也不会校验 DNSSEC，但仍然支持将请求转换为 DoT 发送给上游（[参考：systemd-resolved(8)](https://man.archlinux.org/man/systemd-resolved.8)）。

在被 systemd-resolved 接管的 `/etc/resolv.conf` 文件中，指定的 `nameserver` 就是 `127.0.0.53`。关于 resolved 接管 `resolv.conf` 文件的相关信息，请参考后面小节。

## 4. glibc 的 getaddrinfo 名称解析

glibc 的一些库函数使用 `/etc/nsswitch.conf` 文件来控制其行为，`nsswitch` 表示 [The GNU Name Service Switch (NSS)](https://man.archlinux.org/man/nsswitch.conf.5.en)。

上文中提到的 `nss-resolve` 模块即是配合 glibc 的 `getaddrinfo` 函数，将 DNS 请求交由 systemd-resolved 来处理，这个行为就配置于 `/etc/nsswitch.conf` 的 `hosts` 项中。

```sh {hl_lines=[12]}
$ cat /etc/nsswitch.conf
# Name Service Switch configuration file.
# See nsswitch.conf(5) for details.

passwd: files systemd
group: files [SUCCESS=merge] systemd
shadow: files systemd
gshadow: files systemd

publickey: files

hosts: mymachines resolve [!UNAVAIL=return] files myhostname dns
networks: files

protocols: files
services: files
ethers: files
rpc: files

netgroup: files
```

`nss-resolve` 只是 `getaddrinfo` 解析流程中的一个环节，前后还存在多个其他模块：

- `mymachines`：[`nss-mymachines`](https://man.archlinux.org/man/nss-mymachines.8.en) 模块，让 systemd-machined 解析由其管理的容器和虚拟机名称记录；
- `resolve`：[`nss-resolve`](https://man.archlinux.org/man/nss-resolve.8.en) 模块，让 systemd-resolved 解析由其管理的 DNS 记录，包括 mDNS 和 LLMNR；
- `[!UNAVAIL=return]`：如果上述解析模块可用，则跳过后续的解析模块（[参考：nsswitch.conf(5)](https://man.archlinux.org/man/nsswitch.conf.5.en)）；
- `files`：nss-files 模块，对于 `hosts` 配置项来说，这个文件是指 [`/etc/hosts`](https://man.archlinux.org/man/hosts.5.en)。resolved 已提供同样的功能；
- `myhostname`：[`nss-myhostname`](https://man.archlinux.org/man/nss-myhostname.8.en) 模块，解析 `<hostname>`、`*localhost`、`_gateway`、`_outbound`。resolved 已提供同样的功能；
- `dns`：传统的 nss-dns 模块，将查询发送到 DNS 服务器，通过 `/etc/resolv.conf` 配置（[参考：glibc resolv README](https://github.com/bminor/glibc/blob/master/resolv/README)）。resolved 已提供同样的功能，且接管了 `/etc/resolv.conf` 文件，并将 `nameserver` 配置为了 `127.0.0.53`；

除这些模块外，如果安装了 [Avahi](https://github.com/avahi)，也可以使用 [`nss-mdns`](https://github.com/avahi/nss-mdns) 模块，它会提供 mDNS 查询结果。systemd-resolved 本身已包含这一功能。

> **注意（Ubuntu 24.04 Server）**：`systemd-resolved` 服务默认已经安装并启用，但 `libnss_resolve.so.2` 所在的 `libnss-resolve` 包**默认不安装**。如果直接照搬上面的 `hosts: ... resolve ...` 配置而不安装该包，glibc 加载 NSS 模块会失败，导致 `getaddrinfo` 返回 `Name or service not known`。需要手动安装：
>
> ```bash
> sudo apt update
> sudo apt install libnss-resolve
> ```
>
> 安装后库文件位于 `/usr/lib/x86_64-linux-gnu/libnss_resolve.so.2`。更多 Ubuntu 下的 mDNS 配置细节见后文「Ubuntu 24.04 上开启 mDNS 的完整条件」一节。

## 5. systemd-resolved 接管 /etc/resolv.conf 的方式

如上文中提及的，当程序使用 glibc 访问 DNS 时，DNS 相关信息会在 [`/etc/resolv.conf`](https://man.archlinux.org/man/resolv.conf.5.en) 文件中进行配置。一些应用程序（比如 golang）也可能按照这一惯例来自行实现 `resolv.conf` 配置文件的解析并直接访问 DNS 服务。出于这一原因，为了保持兼容性，systemd-resolved 使用了如下几种形式来接管 `/etc/resolv.conf`：

1. **stub 模式**：当 DNSStubListener 处于启用状态时，使用软链接 `/etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf` 的方式接管配置文件，该文件会将 `nameserver` 配置为 `127.0.0.53`；这是 resolved 推荐的模式；
2. **static 模式**：使用软链接 `/etc/resolv.conf -> /usr/lib/systemd/resolv.conf` 的方式接管配置文件，该文件会将 `nameserver` 配置为 `127.0.0.53`；
3. **uplink 模式**：使用软链接 `/etc/resolv.conf -> /run/systemd/resolve/resolv.conf` 的方式接管配置文件，该文件会将 `nameserver` 直接配置为 resolved 已知的上游 DNS 列表，resolved 会时刻保持其中的内容为最新；若应用程序绕过本地接口而直接使用上游 DNS，将不会提供 mDNS 和 LLMNR 等服务；该模式即为 AdGuard wiki 中提及的模式；
4. **foreign 模式**：由其他的软件包或管理员所管理的 `/etc/resolv.conf` 文件，这种情况下 resolved 并不是文件的提供者而是消费者，当 resolved 自己的[配置文件](https://man.archlinux.org/man/resolved.conf.5.en)中没有显式指定上游 DNS 时，反而会根据该文件来配置上游 DNS；若文件中 `nameserver` 为 `127.0.0.53`，虽然形式上是 foreign 模式，但实际上等同于 stub 模式。

可以使用 `resolvectl status` 命令来查看 `resolv.conf` 的当前模式。

systemd-networkd、NetworkManager 和 iwd 等软件可以通过 `/etc/resolv.conf` 软链接探查到 resolved，并与之配合来完成 DNS 配置。但传统依赖 [resolvconf 工具](https://man.archlinux.org/man/resolvconf.8.en)的程序则无法配合 resolved 完成配置，需要安装 `systemd-resolvconf` 来伪装 resolvconf 工具（[参考：ArchWiki](https://wiki.archlinux.org/title/Systemd-resolved#Setting_DNS_servers)）。

**注意**：

- systemd-resolved 自己的配置文件名称为 `resolved.conf`，注意与 `/etc/resolv.conf` 进行区分；
- man page 中未提及的一点是：当 DNSStubListener 处于停用状态时，`stub-resolv.conf` 又会变为软链接指向 `/run/systemd/resolve/resolv.conf`，这种情况下的 stub 模式实际上等同于 uplink 模式；

## 6. 其他值得注意的行为

基于上述文档，整理出以下几点：

1. 在运行有 systemd-resolved 的节点之间，无需额外安装 Avahi 即可使用 mDNS 功能，即用 `<hostname>.local` 来访问对应的节点；并且还可以使用 LLMNR 功能，即用 `<hostname>` 来访问对应节点。在 Arch 等默认集成 `libnss-resolve` 的发行版上这一体验是开箱即用的，但在 Ubuntu 24.04 Server 上还需要额外配置，详见后文「Ubuntu 24.04 上开启 mDNS 的完整条件」一节；
2. **注**：macOS 开箱支持 mDNS，但不支持 LLMNR；
3. ping `*.localhost` 总是解析到 `127.0.0.1` 或 `::1`，比如 ping `random-test.localhost`。匹配的通式是 `localhost`、`*.localhost`、`localhost.localdomain`、`*.localhost.localdomain`。
4. 还有这些特殊的本地名称也是可以 ping 的：
   1. `_gateway`：解析到网关的地址；
   2. `_outbound`：解析到与网关进行通讯的本地地址；
   3. `_localdnsstub` 固定解析到 `127.0.0.53`（无论是否开启了 DNSStubListener）；
   4. `_localdnsproxy` 固定解析到 `127.0.0.54`（无论是否开启了 DNSStubListener）；
5. tailscale 是通过 D-Bus 接口配合 systemd-resolved 来配置 DNS 的：[`tailscale/blob/main/net/dns/resolved.go`](https://github.com/tailscale/tailscale/blob/main/net/dns/resolved.go)；

```log
Dec 24 21:47:17 chaney-pi3 systemd[1]: Started Network Name Resolution.
Dec 24 21:47:25 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set default route setting: yes
Dec 24 21:47:25 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set LLMNR setting: no
Dec 24 21:47:25 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set MulticastDNS setting: no
Dec 24 21:47:25 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set DNSSEC setting: no
Dec 24 21:47:25 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set DNSOverTLS setting: no
Dec 24 21:47:25 chaney-pi3 systemd-resolved[160303]: Flushed all caches.
Dec 24 21:48:30 chaney-pi3 systemd-resolved[160303]: Using degraded feature set UDP instead of UDP+EDNS0 for DNS server 192.168.0.2.
Dec 24 21:50:40 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set DNS server list to: 100.100.100.100
Dec 24 21:50:40 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set search domain list to: tailxxxxx.ts.net., ......
Dec 24 21:50:40 chaney-pi3 systemd-resolved[160303]: tailscale0: Bus client set default route setting: no
Dec 24 21:50:40 chaney-pi3 systemd-resolved[160303]: Flushed all caches.
Dec 24 21:51:03 chaney-pi3 systemd-resolved[160303]: Using degraded feature set UDP instead of UDP+EDNS0 for DNS server 100.100.100.100.
```

## 7. Ubuntu 24.04 上开启 mDNS 的完整条件

Arch Linux 上 `systemd-resolved` 与 `libnss-resolve` 默认已经协同工作，因此 mDNS 基本开箱即用；但 Ubuntu 24.04 Server 上需要手动把缺失的层级补齐，否则 `<hostname>.local` 无法解析。

### 7.1 需要补齐的几项配置

要让 `<hostname>.local` 在 Ubuntu 24.04 Server 上正常解析，需要把下面几项都配置好。它们分别对应不同的层面，缺少任何一项都可能使 mDNS 无法正常工作。

**首先是 NSS 插件。** Ubuntu 24.04 Server 默认已经运行了 `systemd-resolved`，但 `libnss_resolve.so.2` 所在的 `libnss-resolve` 包默认并没有安装。这个库负责把 glibc 的 `getaddrinfo()` 调用转发给 `systemd-resolved`，缺少它的话，即使 `systemd-resolved` 已经在监听 5353 端口，普通程序也拿不到 mDNS 结果：

```bash
sudo apt update
sudo apt install libnss-resolve
```

安装后库文件会出现在 `/usr/lib/x86_64-linux-gnu/libnss_resolve.so.2`。

**其次是 `systemd-resolved` 的全局开关。** 可以用 drop-in 的方式开启 `MulticastDNS`，这样就不用改动原始主配置文件：

```bash
sudo mkdir -p /etc/systemd/resolved.conf.d
cat <<'EOF' | sudo tee /etc/systemd/resolved.conf.d/60-mdns.conf
[Resolve]
MulticastDNS=yes
EOF
```

**再次是网卡层面的开关。** `systemd-resolved` 要求全局和每个网卡都打开 mDNS 才会真正生效。这里有一个容易忽略的问题：Ubuntu 24.04 Server 虽然默认用 netplan 生成 `systemd-networkd` 配置，但 **netplan 的 YAML 里并没有合法的 `multicast-dns` 字段**，写进去会报 `unknown key`。

正确的做法是给 `systemd-networkd` 生成的网卡配置写 drop-in。先查看 netplan 生成的文件名：

```bash
ls /run/systemd/network
# 示例输出：10-netplan-ens33.network
```

然后把文件名替换为实际值，创建 override：

```bash
sudo mkdir -p /etc/systemd/network/10-netplan-ens33.network.d
cat <<'EOF' | sudo tee /etc/systemd/network/10-netplan-ens33.network.d/override.conf
[Network]
MulticastDNS=yes
EOF
```

**然后是 `/etc/nsswitch.conf`。** 需要在 `hosts` 行里加入 `resolve [!UNAVAIL=return]`，这样 `ping`、`curl` 这类走 glibc `getaddrinfo()` 的程序才会把查询交给 `systemd-resolved`：

```ini
hosts: files resolve [!UNAVAIL=return] dns myhostname
```

**最后是防火墙和网络环境。** 需要放行 UDP 5353 的组播报文：

```bash
sudo ufw allow in proto udp from 224.0.0.0/4 to any port 5353 comment "mDNS"
```

另外，有些虚拟机网桥或云平台会丢弃组播报文，这种环境下 mDNS 即使配置正确也无法工作。

完成上述配置后，应用并重启相关服务：

```bash
sudo netplan apply
sudo systemctl restart systemd-resolved
```

> `MulticastDNS=yes` 表示本机既解析别人的 `.local` 名称，也对外广播自己的主机名；`MulticastDNS=resolve` 则只做客户端解析，不广播自己。

### 7.2 怎么确认已经生效

可以用下面几条命令来验证：

```bash
# 查看全局和每个网卡的 mDNS 开关状态（Link 那行应为 yes）
resolvectl mdns

# 直接调用 systemd-resolved 内部接口，绕过 glibc NSS
resolvectl query target.local

# 走 glibc getaddrinfo 的真实业务路径
getent hosts target.local
```

如果 `resolvectl query` 能解析成功，但 `getent hosts` 不行，问题通常出在 `/etc/nsswitch.conf` 或者 `libnss-resolve` 上。如果两者都失败，再检查网卡 link 层的 `MulticastDNS`、防火墙 UDP 5353 以及网络组播是否可达。

### 7.3 几个容易忽略的地方

- **混淆 `systemd-resolved` 与 `libnss-resolve`**：前者是守护进程，后者是 glibc 的 NSS 插件，Ubuntu 24.04 Server 默认不装后者。
- **只改 `resolved.conf` 全局配置，没开网卡层**：`resolvectl mdns` 的 Link 字段仍是 `-`，mDNS 不会工作。
- **在 netplan YAML 里写 `multicast-dns: true`**：该 key 不合法，需改用 networkd drop-in。
- **没改 `/etc/nsswitch.conf`**：走 glibc 的程序不会使用 `systemd-resolved` 的 mDNS。
- **同时运行 `avahi-daemon`**：会争抢 UDP 5353 端口。如果打算用 `systemd-resolved` 内置的 mDNS，就不要再装 avahi。

## 8. 解决 AdGuard DNS 的 53 端口冲突

AdGuard [官方 wiki 中给出的方案](https://github.com/AdguardTeam/AdGuardHome/wiki/Docker#resolved)，是新增一个 resolved 的 drop-in 配置文件 `/etc/systemd/resolved.conf.d/adguardhome.conf`:

```ini
[Resolve]
DNS=127.0.0.1
DNSStubListener=no
```

然后将 resolv.conf 指向 `/run/systemd/resolve/resolv.conf`，并重启 resolved 服务:

```sh
mv /etc/resolv.conf /etc/resolv.conf.backup
ln -s /run/systemd/resolve/resolv.conf /etc/resolv.conf

systemctl reload-or-restart systemd-resolved
```

这一方案对应前文提到的 uplink 模式：resolved 将 `resolv.conf` 指向上游 DNS 列表。其效果如下：

![本地应用使用 AdGuard DNS](./asserts/adguard-resolved.svg#center)

resolved 的 DNSStubListener 被关闭后：

1. `127.0.0.53:53` 和 `127.0.0.54:53` 实际上被 AdGuard DNS 的 `0.0.0.0:53` 顶替；
2. AdGuard wiki 中建议将 `DNS` 改为 `127.0.0.1`，因为 DNSStubListener 的 `127.0.0.53` 已不再有效。由于此时任何 `127.x.x.x` 地址都会被 AdGuard DNS 的 `0.0.0.0:53` 监听所捕获，因此填写 `127.*.*.*` 也能正常工作；可用 `python3 -m http.server 12345` 与 `curl 127.0.0.55:12345` 验证；
3. 这里填写的是上游 DNS server，由于该 DNS server 位于本节点，也可以填写本节点的其他 IP 地址；
4. DNSStubListener 关闭后，使用 resolved 本地接口的应用程序仍可正常使用 resolved 提供的功能；
5. 绕过 resolved 本地接口的应用程序会直接访问到 AdGuard DNS，因此无法通过传统 DNS 协议获得 mDNS 和 LLMNR 的查询结果；

### 8.1 有没有更好的解决方式？

AdGuard wiki 提供的方案存在以下缺点：

1. 需要在 AdGuard Home 之外额外维护一个 resolved 的 drop-in 配置文件，增加运维负担，且会改变 systemd-resolved 的默认行为；
2. 停用 resolved 的 DNSStubListener 之后，`resolv.conf` 中填写的 `nameserver` 将不是 DNSStubListener 的地址，无法通过传统 DNS 协议获得 resolved 提供的 mDNS 和 LLMNR 查询结果；

AdGuard DNS 并不必须占用 `127.0.0.53:53`，它只是默认监听在 `0.0.0.0:53`。若具体使用场景中没有抢占 `127.0.0.53:53` 的需求，则可将默认监听地址改为自己所需的 IP 地址，修改方式是在 `conf/AdGuardHome.yaml` 中将 `dns.bind_hosts` 的默认值 `0.0.0.0` 修改为具体地址：

```yaml {hl_lines=[4,5]}
// ...
dns:
  bind_hosts:
    - 192.168.x.x
    - 10.x.x.x
  port: 53
// ...
```

若使用 docker 容器运行的方式，也可以补全端口映射，指定到具体的 IP 地址上：`-p IP:host_port:container_port`。

![AdGuard DNS 绑定到具体 IP 上](./asserts/adguard-bind-ip.svg#center)

这样 resolved 和 AdGuard DNS 分别监听各自的 53 端口。通过路由器的 DHCP 配置（或自建的 DHCP 服务），AdGuard DNS 同时会成为 resolved 的上游 DNS，无需修改 `resolv.conf` 的接管模式。

```sh {hl_lines=[4,5,6]}
$ sudo netstat -uanp
Active Internet connections (servers and established)
Proto Recv-Q Send-Q Local Address       Foreign Address  PID/Program name
udp        0      0 127.0.0.54:53       0.0.0.0:*        3047/systemd-res
udp        0      0 127.0.0.53:53       0.0.0.0:*        3047/systemd-res
udp        0      0 192.168.0.2:53      0.0.0.0:*        3042/AdGuardHome
udp        0      0 192.168.0.2:68      0.0.0.0:*        313/systemd-network
udp        0      0 0.0.0.0:5353        0.0.0.0:*        3047/systemd-res
udp        0      0 0.0.0.0:5355        0.0.0.0:*        3047/systemd-res
udp6       0      0 :::5353             :::*             3047/systemd-res
udp6       0      0 :::5355             :::*             3047/systemd-res
```

这样 systemd-resolved 与 AdGuard DNS 可以共存。

## 参考链接

- [Docker · AdguardTeam/AdGuardHome Wiki](https://github.com/AdguardTeam/AdGuardHome/wiki/Docker#resolved)
- [systemd-resolved(8) — Arch manual pages](https://man.archlinux.org/man/systemd-resolved.8)
- [Add support for DNS-over-HTTPS to systemd-resolved · Issue #8639](https://github.com/systemd/systemd/issues/8639)
- [Link-local address - Wikiwand](https://www.wikiwand.com/en/articles/Link-local_address)
- [org.freedesktop.resolve1(5) — Arch manual pages](https://man.archlinux.org/man/org.freedesktop.resolve1.5.en)
- [getaddrinfo(3) — Arch manual pages](https://man.archlinux.org/man/getaddrinfo.3.en)
- [nss-resolve(8) — Arch manual pages](https://man.archlinux.org/man/nss-resolve.8.en)
- [Writing Resolver Clients — systemd.io](https://systemd.io/WRITING_RESOLVER_CLIENTS/)
- [nsswitch.conf(5) — Arch manual pages](https://man.archlinux.org/man/nsswitch.conf.5.en)
- [nss-mymachines(8) — Arch manual pages](https://man.archlinux.org/man/nss-mymachines.8.en)
- [hosts(5) — Arch manual pages](https://man.archlinux.org/man/hosts.5.en)
- [nss-myhostname(8) — Arch manual pages](https://man.archlinux.org/man/nss-myhostname.8.en)
- [glibc/resolv/README — bminor/glibc](https://github.com/bminor/glibc/blob/master/resolv/README)
- [avahi/nss-mdns — GitHub](https://github.com/avahi/nss-mdns)
- [resolv.conf(5) — Arch manual pages](https://man.archlinux.org/man/resolv.conf.5.en)
- [resolved.conf(5) — Arch manual pages](https://man.archlinux.org/man/resolved.conf.5.en)
- [resolvconf(8) — Arch manual pages](https://man.archlinux.org/man/resolvconf.8.en)
- [systemd-resolved — ArchWiki](https://wiki.archlinux.org/title/Systemd-resolved#Setting_DNS_servers)
- [tailscale/net/dns/resolved.go — GitHub](https://github.com/tailscale/tailscale/blob/main/net/dns/resolved.go)
