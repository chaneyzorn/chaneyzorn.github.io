---
title: "Adguard DNS 与 systemd-resolved 配置"
date: 2024-12-24T14:37:03+08:00
isCJKLanguage: true
draft: false
tags: ["systemd", "systemd-resloved", "adguard", "adguard-home", "DNS", "mDNS", "selfhosted", "gethostbyname"]
cover:
    image: "asserts/systemd-logo.svg"
    relative: true
---

## 背景

我在家中使用零刻和树莓派自托管一些服务之后，想通过自定义域名（比如`pve.home.io`）的方式来访问这些服务，这样就可以避免记忆哪些服务在哪些节点上（以及对应的端口是什么）。

具体的做法是，将自定义的域名统一解析到 API Gateway 的 IP 地址上，然后使用 Gateway 的路由功能，根据请求中的具体域名，将请求代理到对应的节点和端口上：

![域名至对应服务](./asserts/dns-api-gateway.svg#center)

我使用的 DNS 服务是 [AdguardHome](https://github.com/AdguardTeam/AdGuardHome)，它默认监听在 `0.0.0.0:53/udp` 上，但是在使用了 systemd 全家桶的节点上，systemd-resolved 会监听在 `127.0.0.53:53/dup` 上，因此会导致端口冲突，Adguard 官方给出的解决方式是修改 resolved 的配置，停止监听 `127.0.0.53:53`[^adguard-wiki]。

[^adguard-wiki]: [Docker · AdguardTeam/AdGuardHome Wiki](https://github.com/AdguardTeam/AdGuardHome/wiki/Docker#resolved)

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

但是对于有洁癖的人来说，非万不得已，是不希望侵入到系统默认的运维配置里的。

于是问题就来了——

## systemd-resolved 在干啥

resolved 对运行在本地的应用程序提供了一个 DNS 中间层，这个中间层的作用是[^resolved]：

1. 对上游的 DNS 记录进行缓存，在网络配置发生变化时自动刷新缓存；
2. 对上游的 DNSSEC 进行验证；
3. 支持将来自本地的 DNS 请求转换为 DoT 发送给上游（暂不支持 DoH[^doh-issue]）；
4. 提供 mDNS 和 LLMNR 服务，以及 link-local 地址反向查找设备名；
5. 提供本地特定别名的地址解析，比如：`<hostname>`、`localhost`、`*.localhost`、`_gateway`、`_outbound`，以及在 `/etc/hosts` 中的映射；

[^resolved]: [systemd-resolved(8) — Arch manual pages](https://man.archlinux.org/man/systemd-resolved.8)
[^doh-issue]: [Add support for DNS-over-HTTPS to systemd-resolved · Issue #8639 · systemd/systemd](https://github.com/systemd/systemd/issues/8639)

**相关术语解释：**

- **DNS**：将域名转换为对应的 IP 地址；
- **DNSSEC**：服务方在 DNS 响应中加上私钥签名，接收方使用公钥验证签名以确保服务方的真实性；
- **DoT**：DNS over TLS，客户端与 DNS 服务端使用 TLS 加密连接来传输查询和响应；
- **DoH**：DNS over HTTPS，客户端与 DNS 服务端使用 HTTPS 协议来传输查询和响应；
- **mDNS**：MulticastDNS，一种用于局域网中设备相互发现的去中心式的协议。传统 DNS 是中心式的，且域名和地址间的映射相对固定，无法及时反映局域网中设备加入和离开（且 IP 地址可能会被随机分配）的场景。mDNS 可以让这些设备方便地互相找到并通信，而不需要复杂的 DNS 配置。比如直接使用 `<hostname>.local` 来访问局域网中对应的 `<hostname>` 节点，而无需预先知道该节点的 IP 地址并手动进行 DNS 配置。
- **LLMNR**：和 mDNS 类似，主要流行于 windows 系统，可以使用类似 `MY-OFFICE-PC` 的名称来访问局域网中的设备；
- **link-local addresses**：仅用于局域网中**单个网段**内部通讯的地址，当无 DHCP 可用时设备可能会自动随机生成一个这样的本地地址。IPv4 地址范围是 `169.254.0.0 - 169.254.255.255`，IPv6 地址范围是 `fe80::/10`。虽然 IPv4 本地地址一般仅在没有 DHCP 时才会被自动生成(或被手动配置)，但当 IPv6 可用时，IPv6 本地地址却总是自动生成并一直存在的[^linklocal]。

[^linklocal]: [Link-local address - Wikiwand](https://www.wikiwand.com/en/articles/Link-local_address)

难怪感觉 `fe80` 很眼熟呢：

```sh
$ ip a | grep "scope link"
    inet6 fe80::be24:11ff:fe17:ef6c/64 scope link proto kernel_ll
    inet6 fe80::42:6aff:fe71:bd0e/64 scope link proto kernel_ll
```

## systemd-resolved 提供的接口形式

resolved 使用以下几种接口对本地应用程序提供服务[^resolved]：

1. D-Bus 接口 `org.freedesktop.resolve1`[^resolved-dbus]；
2. UNIX socket `/run/systemd/resolve/io.systemd.Resolve`；
3. glibc 的 `getaddrinfo` 等相关函数[^getaddrinfo]（通过使用 `nss-resolve` 模块[^nss-resolve]）;
4. DNSStubListener：使用传统的 DNS 访问 `127.0.0.53:53` 和 `127.0.0.54:53`，涵盖 UDP 和 TCP；

另外 resolved 还提供了本节点在局域网中的 mDNS 和 LLMNR 服务：

- mDNS：监听在 `0.0.0.0:5353/udp`；
- LLMNR：监听在 `0.0.0.0:5355`，涵盖 UDP 和 TCP；

![本地应用使用 resolved](./asserts/app-resolved.svg#center)

注意上图中标注的网络范围。各个接口的使用方式各不相同，且支持的特性也存在差异，更多信息请参考 man page[^resolved]和 systemd 官方相关文档[^resolver-client]。

[^resolved-dbus]: [org.freedesktop.resolve1(5) — Arch manual pages](https://man.archlinux.org/man/org.freedesktop.resolve1.5.en)
[^getaddrinfo]: [getaddrinfo(3) — Arch manual pages](https://man.archlinux.org/man/getaddrinfo.3.en)
[^nss-resolve]: [nss-resolve(8) — Arch manual pages](https://man.archlinux.org/man/nss-resolve.8.en)
[^resolver-client]: [Writing Resolver Clients](https://systemd.io/WRITING_RESOLVER_CLIENTS/)

## 127.0.0.53:53 和 127.0.0.54:53 有什么区别？

细心的读者可能会发现，在文章开头的 UDP 端口列表的输出中，不仅存在 `127.0.0.53:53`，还存在一个 `127.0.0.54:53`，为什么会有两个本地的 53 端口监听呢，它们之间有什么区别呢？

如上文中介绍的，对于使用 mDNS 和 LLMNR 的局域网设备，它们的名称和 IP 地址的映射并不是由中心化的 DNS 服务器管理的，所使用的协议也不是监听在 53 端口的传统 DNS 协议，因此对于这些特殊的设备名查询 IP 地址并不能走传统的 DNS 协议。

但既然 resolved 作为一个中间层，增加了对 mDNS 和 LLMNR 的支持，那么输入一个局域网设备名然后输出它的 IP 地址这样的功能自然是可以实现的，这个功能虽然不能架设在传统的 DNS 协议之上，但是仅将结果暴露在 DNS 接口中却是可行的。这就是 `127.0.0.53:53` 额外提供的特殊能力。另外它还会提供对 DNSSEC 的校验能力。

而 `127.0.0.54:53` 仅是上游 DNS 服务器的转发代理，它既不提供 mDNS 和 LLMNR 查询结果，也不会校验 DNSSEC，但仍然支持将请求转换为 DoT 发送给上游[^resolved]。

在被 systemd-resolved 接管的 `/etc/resolv.conf` 文件中，指定的 `nameserver` 就是 `127.0.0.53`。关于 resolved 接管 `resolv.conf` 文件的相关信息，请参考后面小节。

## glibc 的 getaddrinfo 名称解析

glibc 的一些库函数使用 `/etc/nsswitch.conf` 文件来控制其行为，`nsswitch` 表示 The GNU Name Service Switch (NSS)[^nsswitch-conf]。

[^nsswitch-conf]: [nsswitch.conf(5) — Arch manual pages](https://man.archlinux.org/man/nsswitch.conf.5.en)

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

于是我们可以看到，`nss-resolve` 模块仅是 `getaddrinfo` 函数的其中一个环节，它的前后还存在好多其他的模块，于是我们进一步知道了 `getaddrinfo` 解析名称时更完整的流程。

- `mymachines`：nss-mymachines 模块，让 systemd-machined 解析由其管理的容器和虚拟机名称记录[^nss-mymachines]；
- `resolve`：nss-resolve 模块，让 systemd-resolved 解析由其管理的 DNS 记录，包括 mDNS 和 LLMNR[^nss-resolve]；
- `[!UNAVAIL=return]`：如果上述解析模块可用，则跳过后续的解析模块[^nsswitch-conf]；
- `files`[^nsswitch-conf]: nss-files 模块，对于 `hosts` 配置项来说，这个文件是指 `/etc/hosts`[^hosts]。resolved 已提供同样的功能[^resolved]；
- `myhostname`：nss-myhostname 模块，解析 `<hostname>`、`*localhost`、`_gateway`、`_outbound`[^nss-myhostname]。resolved 已提供同样的功能[^resolved];
- `dns`：传统的 nss-dns 模块，将查询发送到 DNS 服务器，通过 `/etc/resolv.conf` 配置[^glibc-resolv]。resolved 已提供同样的功能，且接管了 `/etc/resolv.conf` 文件，并将 `nameserver` 配置为了 `127.0.0.53`[^resolved]；

除这些模块外，如果安装了 [Avahi](https://github.com/avahi)，也可以使用 `nss-mdns` 模块[^nss-mdns]，它会提供 mDNS 查询结果。当然在使用 systemd-resolved 之后就已经包含这个功能了。

[^nss-mymachines]: [nss-mymachines(8) — Arch manual pages](https://man.archlinux.org/man/nss-mymachines.8.en)
[^hosts]: [hosts(5) — Arch manual pages](https://man.archlinux.org/man/hosts.5.en)
[^nss-myhostname]: [nss-myhostname(8) — Arch manual pages](https://man.archlinux.org/man/nss-myhostname.8.en)
[^glibc-resolv]: [glibc/resolv/README at master · bminor/glibc](https://github.com/bminor/glibc/blob/master/resolv/README)
[^nss-mdns]: [avahi/nss-mdns: for the glibc NSS providing mDNS](https://github.com/avahi/nss-mdns)

## systemd-resolved 接管 /etc/resolv.conf 的方式

如上文中提及的，当程序使用 glibc 访问 DNS 时，DNS 相关信息会在 `/etc/resolv.conf` 文件[^resolv-conf]中进行配置。一些应用程序也可能按照这一惯例来自行实现 `resolv.conf` 配置文件的解析并直接访问 DNS 服务。出于这一原因，为了保持兼容性，systemd-resolved 使用了如下几种形式来接管 `/etc/resolv.conf`：

1. **stub 模式**：当 DNSStubListener 处于启用状态时，使用软链接 `/etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf` 的方式接管配置文件，该文件会将 `nameserver` 配置为 `127.0.0.53`；该模式为 resolved 推荐的模式；
2. **static 模式**：使用软链接 `/etc/resolv.conf -> /usr/lib/systemd/resolv.conf` 的方式接管配置文件，该文件会将 `nameserver` 配置为 `127.0.0.53`；
3. **uplink 模式**：使用软链接 `/etc/resolv.conf -> /run/systemd/resolve/resolv.conf` 的方式接管配置文件，该文件会将 `nameserver` 直接配置为 resolved 已知的上游 DNS 列表，resolved 会时刻保持其中的内容为最新；若应用程序绕过本地接口而直接使用上游 DNS，将不会提供 mDNS 和 LLMNR 等服务；该模式即为 Adguard wiki 中提及的模式；
4. **foreign 模式**：由其他的软件包或管理员所管理的 `/etc/resolv.conf` 文件，这种情况下 resolved 并不是文件的提供者而是消费者，当 resolved 自己的配置文件[^resolved-conf]中没有显式指定上游 DNS 时，反而会根据该文件来配置上游 DNS；若文件中 `nameserver` 为 `127.0.0.53`，虽然形式上是 foreign 模式，但实际上等同于 stub 模式。

可以使用 `resolvectl status` 命令来查看 `resolv.conf` 的当前模式。

**注意**：

- systemd-resolved 自己的配置文件名称为 `resolved.conf`，注意与 `/etc/resolv.conf` 进行区分；
- 虽然在 man page 中没有提及，但值得说明的是，当 DNSStubListener 处于停用状态时，`stub-resolv.conf` 又会变为软链接指向 `/run/systemd/resolve/resolv.conf`，这种情况下的 stub 模式实际上等同于 uplink 模式；

[^resolv-conf]: [resolv.conf(5) — Arch manual pages](https://man.archlinux.org/man/resolv.conf.5.en)
[^resolved-conf]: [resolved.conf(5) — Arch manual pages](https://man.archlinux.org/man/resolved.conf.5.en)

## 一些有趣的发现

阅读上述相关文档之后，我得到的一些有趣的收获：

1. 在运行有 systemd-resolved 的节点之间，无需额外安装 Avahi 即可使用 mDNS 功能，即用 `<hostname>.local` 来访问对应的节点；并且还可以使用 LLMNR 功能，即用 `<hostname>` 来访问对应节点；
2. **注**：macOS 开箱支持 mDNS，但不支持 LLMNR；
3. ping `*.localhost` 总是解析到 `127.0.0.1` 或 `::1`，比如 ping `random-test.localhost`。匹配的通式是 `localhost`、`*.localhost`、`localhost.localdomain`、`*.localhost.localdomain`。
4. 还有这些特殊的本地名称也是可以 ping 的：
   1. `_gateway`：解析到网关的地址；
   2. `_outbound`：解析到与网关进行通讯的本地地址；
   3. `_localdnsstub` 固定解析到 `127.0.0.53`（无论是否开启了 DNSStubListener）；
   4. `_localdnsproxy` 固定解析到 `127.0.0.54`（无论是否开启了 DNSStubListener）；
5. tailscale 是通过 D-Bus 接口配合 systemd-resolved 来配置 DNS 的：`tailscale/blob/main/net/dns/resolved.go`[^tailscale-resolved]；

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

[^tailscale-resolved]: [tailscale/net/dns/resolved.go at main · tailscale/tailscale](https://github.com/tailscale/tailscale/blob/main/net/dns/resolved.go)

## 解决 Adguard DNS 的 53 端口冲突

Adguard 官方 wiki 中给出的方案[^adguard-wiki]，是新增一个 resolved 的 drop-in 配置文件 `/etc/systemd/resolved.conf.d/adguardhome.conf`:

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

经过前面大篇幅的铺垫之后，我终于有了足够的背景知识来解读这个方案。这正是上文中提到的 resolved 接管 `resolv.conf` 文件的 uplink 模式，让我们来审视一下这个方案的效果：

![本地应用使用 adguard](./asserts/adguard-resolved.svg#center)

resolved 的 DNSStubListener 被关闭后：

1. `127.0.0.53:53` 和 `127.0.0.54:53` 实际上被 Adguard DNS 的 `0.0.0.0:53` 顶替；
2. Adguard wiki 中说，由于 DNSStubListener 的 `127.0.0.53` 不再有效，所以需要改为 `127.0.0.1`，但我推测填写为 `127.*.*.*` 应该都是可行的，毕竟我们正是因为需要占据这些端口才修改了配置；使用 `python3 -m http.server 12345` 配合 `curl 127.0.0.55:12345` 验证这个观点是成立的；
3. 实际上这里填写的就是上游 DNS server，只不过刚好 DNS server 就在本节点，这里其实也可以填写本节点的其他 IP 地址；
4. 虽然 DNSStubListener 没了，但是使用 resolved 本地接口的应用程序仍然可以正常使用 resolved 提供的功能而不受影响；
5. 对于绕过了 resolved 本地接口的应用程序，将会直接访问到 Adguard DNS，这意味着这个程序将无法通过传统 DNS 协议获得 mDNS 和 LLMNR 的查询结果；

### 有没有更好的解决方式？

~~我 systemd 全家桶天下无敌，凭什么要改我的配置！~~

Adguard wiki 提供的方案存在以下缺点：

1. 需要在 AdguardHome 之外额外维护一个 resolved 的 drop-in 配置文件，增加运维负担，且修改了 systemd-resolved 的默认行为，这个方案是有侵入性的；
2. 停用 resolved 的 DNSStubListener 之后，`resolv.conf` 中填写的 `nameserver` 将不是 DNSStubListener 的地址，无法通过传统 DNS 协议获得 resolved 提供的 mDNS 和 LLMNR 查询结果；

Adguard DNS 并不强依赖于占据 `127.0.0.53:53`，它只是刚好默认监听在 `0.0.0.0:53`。若在具体的使用场景中没有抢占 `127.0.0.53:53` 的需求，则可以将默认的监听地址改为自己所需的 IP 地址，修改方式是在 `conf/AdGuardHome.yaml` 中将 `dns.bind_hosts` 的默认值 `0.0.0.0` 修改为具体的地址：

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

![adguard 绑定到具体 IP 上](./asserts/adguard-bind-ip.svg#center)

于是 resolved 和 adguard DNS 监听在各自的 53 端口上，而通过路由器的 DHCP 配置（或自建的 DHCP 服务），adguard DNS 同时会成为 resolved 的上游 DNS，这样也不需要去改变 `resolv.conf` 的接管模式。

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

整个系统变得更加和谐，皆大欢喜。

## 参考文档
