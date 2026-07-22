---
title: "Clash 广告过滤规则配置"
date: 2025-02-27T16:16:03+08:00
isCJKLanguage: true
draft: false
tags: ["clash", "proxy", "adguard"]
---

## 背景

在前面的文章中有提到，我正在使用 [AdguardHome](https://github.com/AdguardTeam/AdGuardHome) 作为家庭环境的 DNS server。它除了基本的 DNS 功能，更重要的是它的广告过滤功能，这个功能是基于屏蔽特定域名解析实现的。

最近我尝试屏蔽一些少儿不宜的网站，但是我发现这些域名并没有被 AdguardHome DNS server 解析并屏蔽。由此我意识到，有一部分网站是通过代理来发送请求的，需要在代理侧做同样的屏蔽处理。

但我对 Clash proxy 有一些困惑一直没有深入的了解：

- Clash 核心是否有订阅提供商配置的功能，并能定期更新和手动主动更新订阅配置？
- 是否有方式指定一些自定义配置，避免订阅的配置文件更新时覆盖自定义项？

这两个问题的答案是肯定的，并且实际上这个功能已经存在很久了。

## 使用 `proxy-providers` 订阅提供商的节点配置

根据 [clash 配置说明](https://github.com/MetaCubeX/mihomo/blob/Alpha/docs/config.yaml)，可以使用 `proxy-providers` 引用提供商的订阅链接，下面是一个例子：

```yaml
proxy-providers:
  $SUBSCRIPTION.name:
    type: http
    url: "$SUBSCRIPTION.url"
    interval: 3600
    path: ./proxies/$SUBSCRIPTION.name.yaml
    proxy: DIRECT
    header:
      User-Agent:
      - "Clash"
      - "mihomo"
    health-check:
      enable: true
      interval: 600
      # lazy: true
      url: https://cp.cloudflare.com/generate_204
      # expected-status: 204 # 当健康检查返回状态码与期望值不符时，认为节点不可用
    override:
      # skip-cert-verify: true
      # udp: true
```

其中 `$SUBSCRIPTION.name` 这样的写法只是一个示意，需要替换为实际的内容。

可以看到上面配置中的 `interval` 项，是 clash 自动拉取订阅链接的时间间隔。并且如果配合官方的 web UI 面板 [metacubexd](https://github.com/MetaCubeX/metacubexd)，或支持查看 “提供商” 信息的客户端（比如 [FLClash](https://github.com/chen08209/FlClash)），则可以通过主动点击刷新按钮来拉取订阅链接。

这样的写法只会继承提供商的节点信息，其他配置信息则需要自己在配置文件中重新指定一遍。其中一个关键配置是 `proxy-groups`，这里并不需要将提供商的节点信息再抄录一遍，直接在 `use` 中引用其名字即可：

```yaml
proxy-groups:
  - name: PROXY
    type: select
    use:
      - SUBSCRIPTION.name
    proxies:
      - Auto
      - Fallback
  - name: Auto
    type: url-test
    url: "https://cp.cloudflare.com/generate_204"
    interval: 86400
    use:
      - SUBSCRIPTION.name
  - name: Fallback
    type: fallback
    url: "https://cp.cloudflare.com/generate_204"
    interval: 7200
    use:
      - SUBSCRIPTION.name
```

如上配置中，Auto 和 Fallback 会自动测试节点延迟，并选定状态良好的节点。但有时候仍然希望提供手动选择节点的能力，因此另外提供了一个 `select` 类型的 PROXY 组，用于手动选择节点，并且在选择目标中仍然包含 Auto 和 Fallback 组。

这样当 PROXY 组下手动选为 Auto 节点时，实际是使用 Auto 延迟测速后选定的节点。并且这个时候的 PROXY 组下仍然会包含所有提供商的节点供手动选择。

## 使用 `rule-providers` 订阅规则合集

同样的，需要在配置文件中重新指定一下代理规则。这里推荐两个规则合集：

- [Loyalsoldier/clash-rules: 🦄️ 🎃 👻 Clash Premium 规则集(RULE-SET)](https://github.com/Loyalsoldier/clash-rules)
- [217heidai/adblockfilters: 去广告合并规则](https://github.com/217heidai/adblockfilters)

使用方式如下：

```yaml
rule-providers:
  adblockmihomo:
    type: http
    behavior: domain
    url: "https://raw.githubusercontent.com/217heidai/adblockfilters/main/rules/adblockmihomo.yaml"
    path: ./ruleset/adblockmihomo.yaml
    interval: 86400

rules:
  - DOMAIN,clash.razord.top,DIRECT
  - DOMAIN,yacd.haishan.me,DIRECT
  - RULE-SET,adblockmihomo,REJECT
  - GEOIP,LAN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
```

这里只截取了一项作为展示，更具体的配置请参考上面规则合集的页面说明。

可以按照其中的文件格式定义自己想要过滤掉的网站，并在 rules 中指定为 `REJECT`。另外这里使用的 `PROXY` 正是上节中定义的 PROXY 组，两者需要定义为一致的名字（而不是原提供商配置文件中的名字）。

## 注意事项

- Stash 虽然也是基于 Clash Premium 的客户端，但是其版本并不是最新的，可能无法识别部分配置项，参考 [配置样例：Stash 用户文档](https://stash.wiki/configuration/example-config)；
- 由于 iOS Network Extension 在 iOS 14 限制使用 15 MB 内存，在 iOS 15+ 限制使用 50 MB 内存，不合理的配置文件可能会导致 Stash 被 iOS 关闭，因此一个巨大的规则合集并不适用于 iOS 平台，参考 [编写高效的配置文件：Stash 用户文档](https://stash.wiki/faq/effective-stash)；
- `rules` 中的规则顺序对结果是有影响的，如果希望有更好的过滤效果，建议尽量将 `REJECT` 规则放置到前面；
- 若提供商的节点是域名形式的，需要确保 DNS 能够正确的解析这些域名，可以通过 `dns.proxy-server-nameserver` 指定 DNS（这个选项不被 Stash 支持而报错）；

我并没有将 Clash 中的 DNS 配置指定为自己使用的 AdguardHome server，因为外出活动时无法访问到家庭网络环境，因此我只保留了默认的 DNS 配置。

## 参考链接

- [AdguardHome](https://github.com/AdguardTeam/AdGuardHome)
- [clash 配置说明](https://github.com/MetaCubeX/mihomo/blob/Alpha/docs/config.yaml)
- [MetaCubeX/metacubexd: Mihomo Dashboard, The Official One, XD](https://github.com/MetaCubeX/metacubexd)
- [chen08209/FlClash: A multi-platform proxy client based on ClashMeta,simple and easy to use, open-source and ad-free.](https://github.com/chen08209/FlClash)
- [Loyalsoldier/clash-rules: 🦄️ 🎃 👻 Clash Premium 规则集(RULE-SET)](https://github.com/Loyalsoldier/clash-rules)
- [217heidai/adblockfilters: 去广告合并规则](https://github.com/217heidai/adblockfilters)
- [晴耕雨讀 - ClashX 在使用订阅链接的同时添加自定义规则的方法](https://0x3f.org/posts/customize-rules-for-clashx-while-using-a-subscribed-link/)
- [配置样例：Stash 用户文档](https://stash.wiki/configuration/example-config)
- [编写高效的配置文件：Stash 用户文档](https://stash.wiki/faq/effective-stash)
