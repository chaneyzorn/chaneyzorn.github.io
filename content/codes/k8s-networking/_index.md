---
title: "Kubernetes 网络系列"
draft: true
---

Kubernetes 网络覆盖了从容器网卡到跨集群路由的多个层次，涉及 CNI、Service、Ingress、Gateway API、NetworkPolicy、Service Mesh 等众多组件与项目。逐项介绍这些名词虽然能覆盖知识点，却容易让阅读停留在概念表面，难以看清它们为何存在、如何配合。

因此，这里的组织方式是从设计意图入手：先说明容器网络应具备的理想语义，再解释 Kubernetes 为满足这些语义引入了哪些抽象，最后讨论这些抽象在现实中的实现与选型。各章按问题层次展开，每一章处理一个具体问题。

## 导读

### 第 1 章：网络模型的理想假设

如果忽略现有网络设备的限制，重新为容器设计网络，它会提供什么样的语义？这一章先提出四个理想假设——每个容器拥有独立 IP、任意容器直接互通、容器迁移后访问方式不变、网络策略基于身份——再说明它们如何对应到 Pod、Service、NetworkPolicy 等 Kubernetes 核心设计。

### 第 2 章：让每个 Pod 拥有独立 IP

Pod IP 模型是 Kubernetes 网络的基础。当数据中心底层网络无法直接路由 Pod IP 时，Overlay、BGP 路由、eBPF 等技术分别从不同的路径满足"任意 Pod 直接互通"的假设，各自也有不同的适用条件。

### 第 3 章：给 Pod 一个稳定的访问入口

Pod 的 IP 会随重启和调度变化，调用方需要一个稳定的端点。这一章从 Service 抽象出发，讲解 ClusterIP、NodePort、LoadBalancer 的语义差异，以及 kube-proxy 在 iptables、IPVS、eBPF 三种模式下的实现演进。

### 第 4 章：让外部 HTTP 流量按规则进入集群

外部用户如何通过域名和路径访问集群内的服务？这一章对比 Ingress 与 Gateway API 的设计差异，说明入口控制器的现状与选择，包括 `kubernetes/ingress-nginx` 的退役影响和 Gateway API 的迁移方向。

### 第 5 章：按身份而不是按 IP 做网络隔离

容器网络中按 IP 写防火墙规则会很快失效。这一章从 NetworkPolicy 抽象出发，讨论不同 CNI 对策略的实现差异，以及从 L3/L4 到 L7、从 IP 到 FQDN 的策略演进。

### 第 6 章：让服务间通信可观测、可控制

在 Pod 互通的基础上，如何在不修改应用的前提下获得流量管理、可观测和 mTLS 等能力？这一章对比 Sidecar 模式与 Sidecar-less 方案，讨论 Istio、Cilium Service Mesh 等项目的取舍。

### 第 7 章：让多个集群共享同一个网络平面

业务扩展到多个集群后，服务仍需要像单集群一样被发现和访问。这一章讨论 Cilium Cluster Mesh、Submariner、Istio 多集群等方案，以及直接打通 Pod IP 与仅在入口层聚合两种思路的权衡。

### 第 8 章：控制 Pod 如何访问外部网络

默认情况下 Pod 出网使用节点 IP 做 SNAT，这在固定出网 IP、审计和访问控制等场景下不够用。这一章讨论 Egress IP、Egress Gateway 和传统出口代理等方案。

### 第 9 章：高性能与特殊硬件网络

通用容器网络无法满足 AI 训练、高频交易、存储后端等低延迟高吞吐场景。这一章讨论 Multus、SR-IOV、DPDK、RDMA 等技术的适用场景与配置代价。

### 第 10 章：如何为自己的集群选择网络方案

基于前几章对各个网络层次的讨论，这一章给出一个分层次的决策框架，并针对中小规模云环境、大规模裸金属环境、强安全合规等典型场景给出组合建议。
