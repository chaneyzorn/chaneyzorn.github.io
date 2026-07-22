---
title: "使用 PVE 虚拟机部署 3 节点 Kubernetes 集群"
date: 2026-07-21T15:27:16+08:00
isCJKLanguage: true
draft: false
tags: ["kubernetes", "kubeadm", "pve", "proxmox", "containerd", "cilium", "selfhosted"]
---

手头有一台 PVE（Proxmox VE）宿主机，希望在其上创建 3 台 Ubuntu 虚拟机，搭建一个 1 控制面 + 2 工作节点的 Kubernetes 集群，用于学习和测试。

国内环境的主要障碍是网络：k8s 官方 apt 源（pkgs.k8s.io）、镜像仓库（registry.k8s.io、quay.io、docker.io）以及 GitHub raw 均无法直接稳定访问，需要全程替换为国内镜像。本文使用的替代方案：

| 资源 | 官方地址（不可达） | 国内替代 |
|:-----|:-----|:-----|
| Ubuntu ISO / apt 源 | archive.ubuntu.com | mirrors.tuna.tsinghua.edu.cn / mirrors.aliyun.com |
| k8s apt 源 | pkgs.k8s.io | mirrors.aliyun.com/kubernetes-new |
| k8s 组件镜像 | registry.k8s.io | registry.aliyuncs.com/google_containers |
| docker.io / quay.io / gcr.io 镜像 | docker.io / quay.io / gcr.io | docker.m.daocloud.io / quay.m.daocloud.io / gcr.m.daocloud.io |
| GitHub raw / releases 文件 | raw.githubusercontent.com / github.com | jsdelivr，或自备代理 |

软件版本（本文撰写时验证过）：

- PVE 8.x
- Ubuntu Server 24.04 LTS
- containerd 2.2.x（使用 Ubuntu 官方仓库版本）
- Kubernetes v1.36.x（kubeadm 部署）
- Cilium 作为 CNI

## 1. 总体规划

### 1.1 集群拓扑

| 主机名 | IP | 角色 | 最低规格 |
|:-------|:-----|:-----|:-----|
| k8s-cp | 10.8.8.180 | control-plane | 2C / 4G / 40G |
| k8s-node1 | 10.8.8.181 | worker | 2C / 4G / 40G |
| k8s-node2 | 10.8.8.182 | worker | 2C / 4G / 40G |

### 1.2 网络规划

| 网络 | 网段 | 说明 |
|:-----|:-----|:-----|
| 节点网络 | 10.8.8.0/24 | 虚拟机桥接 vmbr0，与 PVE 同网段；网关 10.8.8.1，DNS 10.8.8.66 / 8.8.8.8 |
| Pod 网络 | 10.244.0.0/16 | 由 Cilium 分配使用，不得与节点网络重叠 |
| Service 网络 | 10.96.0.0/12 | 不得与节点/Pod 网络重叠 |

## 2. PVE 上准备 Ubuntu 虚拟机

### 2.1 下载 Ubuntu Server 镜像

在 PVE 节点上下载 ISO（用清华镜像站，国内访问较快）：

```bash
cd /var/lib/vz/template/iso/
wget https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.4-live-server-amd64.iso
```

具体文件名以 <https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/> 列表为准。

### 2.2 创建第一台虚拟机

PVE Web 界面「创建 VM」，主要选项：

- 常规：名称 `ubuntu-k8s-tpl`（之后转为模板）
- 操作系统：选择刚下载的 ISO，Guest OS 类型 Linux 6.x
- 系统：机器类型 q35，SCSI 控制器 VirtIO SCSI single，BIOS 默认 SeaBIOS
- 磁盘：VirtIO Block，40 GB
- CPU：2 核以上，类型 host
- 内存：4096 MB 以上
- 网络：桥接 vmbr0，模型 VirtIO（半虚拟化）

### 2.3 安装 Ubuntu Server

启动虚拟机进入安装程序，注意：

- 语言建议选 English（避免控制台中文乱码）
- 网络先保持 DHCP，静态 IP 留到克隆后逐台配置
- 存储使用整块磁盘即可（默认 LVM 方案无妨）
- 勾选 `Install OpenSSH server`
- Ubuntu Server 默认不创建 swap 分区，无需额外处理

安装完成后重启，SSH 登录进行基础配置。

### 2.4 安装后基础配置（在模板机内执行）

Ubuntu 24.04 的 apt 源为 DEB822 格式，替换为国内镜像：

```bash
sudo sed -i -e 's@//.*archive.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' \
            -e 's@//security.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' \
            /etc/apt/sources.list.d/ubuntu.sources
sudo apt-get update && sudo apt-get full-upgrade -y
```

安装常用工具和 qemu-guest-agent（PVE 感知虚拟机状态、安全关机所必需）：

```bash
sudo apt-get install -y qemu-guest-agent curl vim net-tools
```

同时在 PVE 端该虚拟机的「选项 → QEMU Guest Agent」勾选启用。

注意 qemu-guest-agent 不需要手动 `systemctl enable`：它的 unit 没有 `[Install]` 段（执行 enable 会提示 "no installation config"，属正常现象），PVE 端勾选后虚拟机内会出现 `/dev/virtio-ports/org.qemu.guest_agent.0` 设备，udev 检测到后会自动拉起服务。验证：

```bash
systemctl status qemu-guest-agent          # 应为 active (running)
ls /dev/virtio-ports/                      # 应看到 org.qemu.guest_agent.0
```

服务正常后，PVE 的虚拟机摘要页面会显示该虚拟机的 IP 地址。

清理模板，避免克隆出的机器互相冲突：

```bash
# 清空 machine-id，首次启动时会自动重新生成
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo ln -s /etc/machine-id /var/lib/dbus/machine-id

# 禁用 cloud-init，防止它按旧配置覆盖网络
sudo touch /etc/cloud/cloud-init.disabled

# 检查 netplan 配置，确保没有 macaddress 绑定字段（克隆后网卡 MAC 会变）
sudo cat /etc/netplan/*.yaml

sudo poweroff
```

### 2.5 转为模板并克隆

在 PVE Web 界面右键该虚拟机「转换成模板」，然后从模板 **完整克隆（Full Clone）** 出 3 台：

- `k8s-cp`
- `k8s-node1`
- `k8s-node2`

### 2.6 克隆后逐台修改主机名和静态 IP

以 k8s-cp 为例（k8s-node1 用 10.8.8.181、k8s-node2 用 10.8.8.182，其余相同）：

```bash
sudo hostnamectl set-hostname k8s-cp
```

编辑 netplan（文件名以实际为准，通常是 `/etc/netplan/00-installer-config.yaml`）：

```yaml
network:
  version: 2
  ethernets:
    ens18:
      dhcp4: false
      addresses: [10.8.8.180/24]
      routes:
        - to: default
          via: 10.8.8.1
      nameservers:
        addresses: [10.8.8.66, 8.8.8.8]
```

```bash
# 修正权限，否则 netplan 会警告 "Permissions ... are too open"
sudo chmod 600 /etc/netplan/00-installer-config.yaml
sudo netplan apply
```

## 3. 所有节点：系统初始化

以下操作在 **3 台节点上都要执行**。

配置 hosts 互相解析（可选但推荐）：

```bash
cat <<'EOF' | sudo tee -a /etc/hosts
10.8.8.180 k8s-cp
10.8.8.181 k8s-node1
10.8.8.182 k8s-node2
EOF
```

时区与时间同步（节点间时间偏差会导致证书校验失败）：

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo sed -i 's/^#NTP=.*/NTP=ntp.aliyun.com/' /etc/systemd/timesyncd.conf
sudo systemctl restart systemd-timesyncd
```

关闭 swap（kubelet 要求）：

```bash
sudo swapoff -a
sudo sed -i '/\bswap\b/s/^/#/' /etc/fstab
```

加载内核模块并开启 iptables 桥接转发：

```bash
cat <<'EOF' | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

cat <<'EOF' | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
```

防火墙：Ubuntu 默认 ufw 未启用、PVE 虚拟机防火墙默认关闭，则无需处理。如果启用过防火墙，控制面需放行 6443、2379-2380、10250、10251、10252、10257、10259，工作节点需放行 10250、30000-32767。

## 4. 所有节点：安装 containerd

直接使用 Ubuntu 官方仓库的 containerd（24.04 仓库当前为 2.2.x），省去额外配置第三方源：

```bash
sudo apt-get install -y containerd
```

生成完整默认配置并修改：

```bash
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
```

需要改四处：

```bash
# 1. 使用 systemd cgroup driver（与 kubelet 保持一致）
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# 2. pause 沙箱镜像改为阿里云镜像（tag 保持不变）
sudo sed -i 's#registry.k8s.io/pause#registry.aliyuncs.com/google_containers/pause#' /etc/containerd/config.toml

# 3. 置空 cri registry 段的 config_path：Ubuntu 的 containerd 2.2 默认配置里它
#    非空（如 '/etc/containerd/certs.d:/etc/docker/certs.d'），与下一步的内联
#    mirrors 互斥，不置空会导致 CRI 插件加载失败（值以实际文件为准）
sudo sed -i "s#config_path = '/etc/containerd/certs.d:/etc/docker/certs.d'#config_path = ''#" /etc/containerd/config.toml
grep -n config_path /etc/containerd/config.toml   # 确认 cri registry 段的值已为空
```

```bash
# 4. 为 docker.io / quay.io / gcr.io 等配置镜像加速，追加到配置文件末尾
cat <<'EOF' | sudo tee -a /etc/containerd/config.toml

[plugins.'io.containerd.cri.v1.images'.registry.mirrors.'docker.io']
  endpoint = ['https://docker.m.daocloud.io', 'https://registry-1.docker.io']
[plugins.'io.containerd.cri.v1.images'.registry.mirrors.'quay.io']
  endpoint = ['https://quay.m.daocloud.io', 'https://quay.io']
[plugins.'io.containerd.cri.v1.images'.registry.mirrors.'gcr.io']
  endpoint = ['https://gcr.m.daocloud.io', 'https://gcr.io']
[plugins.'io.containerd.cri.v1.images'.registry.mirrors.'registry.k8s.io']
  endpoint = ['https://k8s.m.daocloud.io', 'https://registry.k8s.io']
EOF
```

> 注意：以上写法对应 containerd 2.x 的 v3 配置格式（CRI 插件路径为 `io.containerd.cri.v1.images`，配置文件开头 `version = 3`），已在 Ubuntu 24.04 仓库的 containerd 2.2.1 上实际验证。如果用的是 containerd 1.7，插件路径是 `io.containerd.grpc.v1.cri`，且没有 config_path 互斥问题。如果之前按不匹配的版本改过配置，直接重新执行 `containerd config default | sudo tee /etc/containerd/config.toml` 从头再来即可。

配置 crictl（排查容器问题时用）。crictl 由 `cri-tools` 包提供：Ubuntu 仓库里它在 universe 组件中，第 5 节的 kubernetes-new 源也会提供，第 5 节会显式安装。所以这里只写配置文件即可，crictl 验证留到第 5 节之后：

```bash
cat <<'EOF' | sudo tee /etc/crictl.yaml
runtime-endpoint: unix:///var/run/containerd/containerd.sock
image-endpoint: unix:///var/run/containerd/containerd.sock
timeout: 10
EOF
```

重启并验证（containerd 没有 config check 子命令，用 `config dump` 输出解析后的实际配置来检查，语法错误会直接报出来）：

```bash
sudo systemctl restart containerd
sudo systemctl enable containerd
systemctl is-active containerd                    # 应为 active
containerd config dump | grep -i systemdCgroup    # 应为 true
containerd config dump | grep daocloud            # 应看到 mirrors 已生效
containerd config dump | grep disabled            # 不应看到 disabled_plugins 包含 "cri"
sudo journalctl -u containerd -b --no-pager | grep 'failed to load plugin'   # 应无输出
```

> 如果最后一条 grep 有输出（常见为 `mirrors cannot be set when config_path is provided` 或 cri 被 disabled_plugins 禁用），说明 CRI 插件没有加载，kubeadm 会报 `unknown service runtime.v1.RuntimeService`，按输出提示回头检查配置。

待第 5 节装好 cri-tools 后，还可以实测拉取：

```bash
crictl pull docker.io/library/nginx:1.27-alpine     # 实测加速拉取
```

## 5. 所有节点：安装 kubeadm / kubelet / kubectl

使用阿里云的 kubernetes-new 源（社区 pkgs.k8s.io 的镜像。注意旧源 `mirrors.aliyun.com/kubernetes/apt` 停留在 1.28，不要再用）。

如需其他小版本，把下面 URL 中的 `v1.36` 换掉即可（可用版本列表见 <https://mirrors.aliyun.com/kubernetes-new/core/stable/>）：

```bash
sudo apt-get install -y apt-transport-https ca-certificates gpg
sudo install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.36/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://mirrors.aliyun.com/kubernetes-new/core/stable/v1.36/deb/ /" | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
```

查看可用版本并安装（3 台节点版本必须一致）：

```bash
apt-cache madison kubeadm | head -5     # 记下版本号，如 1.36.2-1.1
# cri-tools（crictl）在新版打包中不一定是 kubeadm 的强依赖，显式安装
sudo apt-get install -y kubelet kubeadm kubectl cri-tools
sudo apt-mark hold kubelet kubeadm kubectl
```

## 6. 控制面：kubeadm init

在 **k8s-cp** 上编写初始化配置 `kubeadm-init.yaml`：

```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: 10.8.8.180           # 控制面节点 IP
  bindPort: 6443
nodeRegistration:
  criSocket: unix:///var/run/containerd/containerd.sock
  imagePullPolicy: IfNotPresent
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: v1.36.2              # 与 apt-cache madison 查到的版本一致（去掉 -1.1 后缀）
imageRepository: registry.aliyuncs.com/google_containers
networking:
  podSubnet: 10.244.0.0/16              # 与 Cilium 的 clusterPoolIPv4PodCIDRList 一致
  serviceSubnet: 10.96.0.0/12
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
```

说明：

- 必须显式写 `kubernetesVersion`，否则 kubeadm 会去 dl.k8s.io 查询最新版本，国内可能超时。
- 必须显式配置 `imageRepository`，否则默认从 registry.k8s.io 拉取组件镜像，国内无法直接拉取。
- v1beta3 已在 kubeadm 1.34 中移除，1.34 及以上必须使用 v1beta4；如果安装的是 1.33 及更早版本，把 apiVersion 改回 `kubeadm.k8s.io/v1beta3` 即可，本例用到的字段在两个版本中位置相同。也可执行 `kubeadm config print init-defaults` 查看当前 kubeadm 的默认配置格式。

先预拉镜像验证镜像源可用，再执行初始化：

```bash
sudo kubeadm config images pull --config kubeadm-init.yaml
sudo kubeadm init --config kubeadm-init.yaml
```

成功后按输出提示配置 kubectl：

```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

**保存 init 输出末尾的 `kubeadm join ...` 命令**，第 8 步要用。如果丢失可重新生成：

```bash
kubeadm token create --print-join-command
```

## 7. 控制面：安装 CNI 插件（Cilium）

不装 CNI 的话节点会一直停留在 NotReady。目前主流 CNI 是 **Cilium、Calico、Flannel** 三家。Cilium 基于 eBPF，2023 年从 CNCF 毕业，被 GKE、Azure 等托管 k8s 服务采用，支持 L3-L7 NetworkPolicy、Hubble 流量可观测，还可完全替代 kube-proxy；Calico 以 BGP 路由和网络策略见长，企业集群常见；Flannel 最轻量，但不支持 NetworkPolicy。本文选用 Cilium。

### 7.1 安装 Cilium

Cilium 对内核的要求是 4.19+（5.10+ 可解锁全部特性），Ubuntu 24.04 自带的 6.8 内核完全满足。

下载 cilium-cli（GitHub releases 国内不可直达，请自行通过代理下载，或找能出网的机器下载后 scp 过来）：

```bash
wget https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
sudo tar xzvf cilium-linux-amd64.tar.gz -C /usr/local/bin
```

安装：

```bash
cilium install --set ipam.operator.clusterPoolIPv4PodCIDRList=10.244.0.0/16
cilium status --wait
```

说明：

- `clusterPoolIPv4PodCIDRList` 必须与 `kubeadm-init.yaml` 中的 `podSubnet` 一致。
- 默认保留 kube-proxy，对 kubeadm 集群开箱即用。
- Cilium 镜像托管在 quay.io，第 4 步配置的 quay.m.daocloud.io 镜像加速自动生效，无需改任何镜像地址。

可选：验证集群网络连通性（会额外拉取 quay.io 上的测试镜像，同样走镜像加速）：

```bash
cilium connectivity test
```

注意其中的外网连通用例（访问 1.1.1.1）在国内无法连通，失败属预期，不影响对集群内网络功能的判断。个别用例（如 L7 负载均衡的 l7-lb）的镜像若拉取失败（ImagePullBackOff），可用 `kubectl -n cilium-test-1 describe pod <pod>` 在 Events 里看具体镜像和原因，一般是该镜像在镜像加速服务上不可用，可忽略该用例。测试资源都创建在 `cilium-test-1` namespace 中，验证完删除该 namespace 即清理干净：

```bash
kubectl delete namespace cilium-test-1
```

进阶：Cilium 可以完全替代 kube-proxy（`kubeProxyReplacement=true`，需在 `kubeadm init` 时跳过 kube-proxy 插件或事后移除），并可启用 Hubble Relay/UI 做流量可观测，按需参考官方文档开启。

## 8. worker 节点：加入集群

在 **k8s-node1、k8s-node2** 上分别执行第 6 步保存的 join 命令，形如：

```bash
sudo kubeadm join 10.8.8.180:6443 \
  --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:xxxxxxxx
```

注意 init 输出的 join 命令原文不带 `sudo`，直接复制执行会报 `ERROR IsPrivilegedUser`，记得补上。

worker 的组件镜像同样来自 registry.aliyuncs.com/google_containers（join 时 kubeadm 只拉 pause 和 kube-proxy， kubeadm 会沿用镜像仓库设置；如拉取失败，可先 `sudo kubeadm config images pull --image-repository registry.aliyuncs.com/google_containers`）。

worker 加入后，Cilium agent 会以 DaemonSet 形式自动在新节点上启动，无需额外操作。

## 9. 验证集群

在控制面上：

```bash
kubectl get nodes -o wide        # 3 个节点均为 Ready
kubectl get pods -A              # 系统组件全部 Running（加 -w 可持续观察状态变化）
cilium status                    # Cilium 各节点 agent 正常
```

部署一个测试应用（nginx 镜像经 docker.m.daocloud.io 加速拉取）：

```bash
kubectl create deployment web --image=nginx:1.27-alpine --replicas=3
kubectl expose deployment web --port=80 --type=ClusterIP
kubectl get pods -o wide
kubectl get svc web
curl <web 的 ClusterIP>
```

如需在控制面节点上调度普通 Pod（测试集群常见需求）：

```bash
kubectl taint nodes k8s-cp node-role.kubernetes.io/control-plane:NoSchedule-
```

## 10. 安装 helm（可选）

helm 是 k8s 的包管理工具，后续安装 Hubble UI、ingress-controller 等 chart 会用到。它是纯客户端工具，装在操作集群的机器上即可（如 k8s-cp），直接使用 `~/.kube/config`。

方式一：官方安装脚本（自动安装最新版）：

```bash
# raw.githubusercontent.com 不可直达，脚本本身走 jsdelivr 下载
curl -fsSL https://cdn.jsdelivr.net/gh/helm/helm@main/scripts/get-helm-3 -o get-helm-3.sh
bash get-helm-3.sh
```

脚本会从 get.helm.sh（Azure CDN，国内一般可直连）下载 helm 二进制。

方式二：手动下载指定版本：

```bash
# 版本号到 https://github.com/helm/helm/releases 查看（页面打不开就走代理）
curl -fLO https://get.helm.sh/helm-v3.18.4-linux-amd64.tar.gz
tar xzf helm-v3.18.4-linux-amd64.tar.gz
sudo install -m 0755 linux-amd64/helm /usr/local/bin/helm
```

验证：

```bash
helm version
# 可选：验证 repo 可用（helm.cilium.io 托管在 GitHub Pages，国内一般可达）
helm repo add cilium https://helm.cilium.io && helm repo update
```

## 11. 常见问题

- **kubeadm init 卡在拉镜像**：检查是否忘了 `imageRepository`；用 `kubeadm config images pull --config kubeadm-init.yaml` 单独验证拉取。
- **kubeadm 报 `unknown service runtime.v1.RuntimeService`**：containerd 的 CRI 插件没有加载。用 `sudo journalctl -u containerd -b --no-pager | grep 'failed to load plugin'` 看具体原因——最常见两种：一是 cri registry 段的 `config_path` 非空与内联 `mirrors` 互斥（Ubuntu containerd 2.2 的默认配置即如此，按第 4 节置空即可）；二是配置里 `disabled_plugins` 包含了 "cri"。修复并 `systemctl restart containerd` 后，`sudo crictl version` 能列出 RuntimeVersion 即恢复。
- **init 报 cgroup driver 不匹配**：确认 containerd 的 `SystemdCgroup = true` 且 init 配置里 `cgroupDriver: systemd`，两边一致后 `sudo systemctl restart containerd` 重试。
- **节点一直 NotReady**：多半是 CNI 插件未就绪。`kubectl describe node <节点>` 看 Conditions；Cilium 用 `cilium status` 和 `kubectl -n kube-system logs -l k8s-app=cilium` 排查。镜像拉取失败时检查 quay 加速配置。
- **kubelet 启动失败 / 反复重启**：`journalctl -u kubelet -f` 看日志，常见原因是 swap 未完全关闭或配置文件错误。
- **克隆的虚拟机注册冲突**：machine-id 重复会导致 kubelet 无法正常注册，重新生成： `sudo rm /etc/machine-id && sudo systemd-machine-id-setup`，再重启 kubelet。
- **join token 过期（默认 24 小时）**：在控制面执行 `kubeadm token create --print-join-command` 重新生成。
- **GitHub 直连失败**：raw 文件和 releases 下载在国内不可直达时，请自行使用代理，或找一台能出网的机器下载好文件再 scp 过来。

## 12. 附录：镜像代理的配置位置与流程

本文涉及"拉镜像"的代理一共分布在 3 个位置，分两类机制，另有 1 类容易混淆的非镜像代理。

### 配置位置

**1. containerd registry mirrors（`/etc/containerd/config.toml`，第 4 节）—— 透明代理，覆盖名字固定的第三方镜像**

| 原镜像仓库 | 代理 endpoint | 兜底 |
|:---|:---|:---|
| docker.io | docker.m.daocloud.io | registry-1.docker.io |
| quay.io | quay.m.daocloud.io | quay.io |
| gcr.io | gcr.m.daocloud.io | gcr.io |
| registry.k8s.io | k8s.m.daocloud.io | registry.k8s.io |

生效对象：cilium 等组件清单里写死的 quay.io 镜像、手动部署的 nginx （docker.io）、connectivity test 的测试镜像（gcr.io）等。好处是无需修改镜像清单本身。前提是把 `config_path` 置空（containerd 2.2 默认启用的 certs.d 目录方式与内联 mirrors 互斥，否则 CRI 插件加载失败，见第 4 节）。

**2. containerd pause 沙箱镜像（同文件 `pinned_images` 的 `sandbox`）—— 改名换源**

把 `registry.k8s.io/pause` 改为 `registry.aliyuncs.com/google_containers/pause`。这不是代理，是直接把镜像名指到国内可达的地址。

**3. kubeadm 的 `imageRepository`（`kubeadm-init.yaml`，第 6 节）——改名换源**

`registry.aliyuncs.com/google_containers` 作用于 kubeadm 负责拉取的全部控制面组件：kube-apiserver、kube-controller-manager、kube-scheduler、kube-proxy、 etcd、coredns、pause。kubeadm 拼镜像名时用它替换默认的 `registry.k8s.io` 前缀。

**（区分）非镜像代理**：apt 包走清华/阿里云源、cilium-cli 等 GitHub 文件下载需自备代理——这些是文件/包下载，与 containerd 镜像代理是两条独立的线。

### 代理流程

以 kubelet 在某节点启动一个 cilium Pod（镜像 `quay.io/cilium/cilium:vX.Y.Z`）为例：

1. kubelet 通过 CRI 调 containerd 的 `PullImage`
2. containerd 的 CRI 插件解析镜像引用，提取 registry 主机名 `quay.io`
3. 查 registry 配置：命中 mirrors，endpoint 列表第一个是 `https://quay.m.daocloud.io`
4. 向该 endpoint 发标准 OCI registry 请求（先 Head/GET manifest，再 GET blob），镜像路径保持原样（`/cilium/cilium/...`）；daocloud 作为缓存代理回源 quay.io 取数返回
5. 第一个 endpoint 失败则按列表顺序回退到下一个
6. 成功则 unpack 到 snapshotter，镜像入库，Pod 创建

而 `kubeadm init` 拉控制面镜像走的是另一条路径：镜像名已被拼成 `registry.aliyuncs.com/google_containers/kube-apiserver:vX.Y.Z`，主机名是 `registry.aliyuncs.com`，不命中任何 mirrors 规则，直连阿里云（国内可达，无需代理）。

两者的分工：**mirrors 透明代理管第三方镜像（yaml 里名字固定的）， imageRepository / pause 改名换源管 k8s 官方组件**——前者在 resolver 层替换 endpoint，后者在生成镜像名时直接换掉前缀。

## 参考链接

- [Installing kubeadm - Kubernetes](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/)
- [kubeadm init - Kubernetes](https://kubernetes.io/docs/reference/setup-tools/kubeadm/kubeadm-init/)
- [kubeadm 配置 API（v1beta4）- Kubernetes](https://kubernetes.io/docs/reference/config-api/kubeadm-config.v1beta4/)
- [Container runtimes - Kubernetes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [阿里云镜像站 kubernetes-new 目录](https://mirrors.aliyun.com/kubernetes-new/core/stable/)
- [DaoCloud 公开镜像加速说明](https://github.com/DaoCloud/public-image-mirror)
- [Cilium 官方文档](https://docs.cilium.io/)
- [Cilium - GitHub](https://github.com/cilium/cilium)
- [清华镜像站 Ubuntu releases](https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/)
- [Qemu/KVM Virtual Machines - Proxmox VE Wiki](https://pve.proxmox.com/wiki/Qemu/KVM_Virtual_Machines)
- [Helm 官方文档](https://helm.sh/docs/)
