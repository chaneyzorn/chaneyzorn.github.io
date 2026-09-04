---
title: "基础环境检查工具的自包含分发"
date: 2026-08-31T00:00:00+08:00
isCJKLanguage: true
draft: true
tags: ["ansible", "python", "shiv", "bare-metal"]
---

最近根据项目需求，需要在集群部署之前对基础环境进行检查，以减少后续部署和上线的阻碍。检查的目标环境的操作系统基线是 ubuntu 22.04/24.04，只安装了基本的系统和驱动，因此不包含额外可以利用的组件，比如 docker 和 nodejs 等，且环境通常不与外网连通，无法临时在线安装检查所需的工具。

在设计检查工具时，目标环境无依赖可用，因此一个核心考量是，让执行检查所需的所有代码逻辑、依赖库、使用的三方工具都自包含在检查工具内，以避免目标环境依赖缺失问题，且确保不对目标环境做侵入式的工具植入，不触及系统自身的包管理，保持环境纯净。

对于多节点上的任务执行，我们选择了主流的 Ansible，Python 是我们的起步依赖。好消息是 ubuntu22.04 基础系统内置了 python3.10，所以我们将 python3.10+ 作为目标环境基线的一部分，除此之外的部分都由检查工具自包含。具体来说，在 python 已经是基座的情况下，包含这些部分：

- 使用 python 开发的巡检工具主体代码，以及它所需的第三方 python 依赖库；
- Ansible 命令工具，以及它的 python 依赖库；
- 执行检查所需的三方工具，比如 nvmecli 和 nccl-test 等工具；
- 汇报检查结果时所需的 html 单文件模板；

最终交付物只有一个压缩包，用户解压后只需要执行：

```bash
dist/bare-metal-check run \
  --nodes <node1>,<node2>,<node3>
```

运行时不需要安装任何依赖。下面主要说明这几个部分是如何自包含在检查工具内的，以及在执行过程中如何分发到目标环境中。

## 2. CLI 连同依赖打成单文件 pyz

### 2.1 为什么选 shiv

CLI 本身依赖不多，但 `ansible-core` 会带来 `cryptography`、`cffi`、`PyYAML`、`MarkupSafe` 这类带原生扩展的传递依赖。可选的单文件方案里，PyInstaller 一类是把解释器也打进去，体积和构建复杂度都高；[shiv](https://github.com/linkedin/shiv) 基于 Python 标准库的 [zipapp](https://docs.python.org/3/library/zipapp.html) 实现——把项目代码和全部依赖的 wheel 打包进一个 zip，加一行 shebang，就是一个可执行文件。前提是控制节点上有兼容的 Python 3 解释器，这在目标场景里可以接受，换来的是产物只有约 9 MB、构建过程简单。

实际打包命令（`build/targets/pyz/entrypoint.sh`）：

```bash
uv run --no-dev --group packaging --locked shiv \
    --output-file "$output" \
    --entry-point bare_metal_check.cli:main \
    --python '/usr/bin/env python3' \
    ".[ansible]"
```

其中几处细节的作用：

- **`uv run --locked`** 保证 shiv 解析依赖时严格遵守 `uv.lock`，构建结果可复现。
- **`--python '/usr/bin/env python3'`** 指定产物首行 shebang。如果不指定，shiv 会把构建容器中的解释器绝对路径写进去，部署到目标环境后可能找不到解释器。
- `--entry-point` 指定 zip 启动时执行的入口函数，这里是命令行框架 Click 定义的命令组 `bare_metal_check.cli:main`。
- 依赖里带原生扩展的库（cryptography、PyYAML 等）都有 manylinux wheel，shiv 直接使用这些 wheel，不需要在构建时编译；代价是**产物与平台/架构绑定**——容器里构建出来的就是 `linux-x86_64`，文件名里也带上了平台标识，如果需要其他平台的产物，就要在对应平台上重新构建。

### 2.2 在容器内构建

所有构建目标统一走 `build/build.sh <target>` → `build/lib/run-in-container.sh` 这条调用路径。后者是一个通用的容器封装：读取 `build/targets/<target>/config.sh` 里声明的 Dockerfile、入口脚本、输出目录和挂载方式，然后启动容器执行入口脚本。

两个设计细节：

- **镜像 tag 由 Dockerfile 内容的 sha256 派生**。`pyz`、`html-report`、`packall`、`diagnostic` 四个目标共用一个 `common` builder 镜像（Ubuntu 22.04 + Python/uv + Node/npm，以及供 `diagnostic` 目标使用的诊断工具链，见第 4 节），只要 Dockerfile 没变就复用本地镜像；`nccl-tests` 额外把 CUDA 基础镜像名混入 hash，保证不同 CUDA/Ubuntu 组合不混用。
- **容器以当前用户 UID/GID 运行**（`--user $(id -u):$(id -g)`），构建产物直接归宿主用户，避免了 Docker 构建常见的 root 属主文件问题。

## 3. Ansible 复用同一份 pyz：SHIV_CONSOLE_SCRIPT

CLI 执行检查时需要调用 `ansible-playbook` 和 `ansible-inventory`。常规做法是从 PATH 找这两个命令，但那意味着现场还得安装一份版本对得上的 Ansible——自包含就失效了。

这里用到了 shiv 的一个内建机制：**`SHIV_CONSOLE_SCRIPT` 环境变量**。shiv 打包时会执行一次 pip 安装，依赖包（ansible-core）的所有 console scripts 都被收进 zip 内的 `site-packages/bin/`。运行时如果这个环境变量有值，shiv 的 bootstrap 就不执行构建时指定的默认入口，转而执行 zip 里同名的 console script。

所以 runner 调用 Ansible 的方式是——**让同一个 pyz 再执行一次，只是换成 Ansible 的入口**（`src/bare_metal_check/runner.py`）：

```python
def _ansible_cmd(self, console_script: str):
    env = self._ansible_env()
    env["SHIV_CONSOLE_SCRIPT"] = console_script
    return [sys.executable, str(self.pyz_path)], env
```

子进程命令是 `python3 <同一个 .pyz> ...`，靠 `SHIV_CONSOLE_SCRIPT=ansible-playbook` 切换到包内 ansible-core 的入口。CLI 和 Ansible 用的是同一个 zip 里的依赖，版本必然一致，消除了「控制节点上 Ansible 版本不对」这一类问题。

配套地，runner 在初始化时强制自检，防止从源码或 venv 直接运行（那种情况下 `SHIV_CONSOLE_SCRIPT` 机制不成立）：

```python
pyz = Path(sys.argv[0]).resolve()
if pyz.is_file() and zipfile.is_zipfile(pyz):
    return pyz
# 否则报错退出：must be run from the packaged .pyz executable
```

判定条件只有一个：`sys.argv[0]` 指向的文件本身是 zip 格式。这也是 CLI 约定「必须从 `.pyz` 启动」的原因。

## 4. 离线工具的构建与分发

检查需要在目标节点上运行 `dmidecode`、`ethtool`、`iperf3`、`nvme`、`smartctl`、`lspci` 等诊断命令，以及 NCCL 性能测试。现场离线，apt 不可用；目标节点不一定有容器运行时，引入镜像守护进程本身还会改变被检环境，因此我排除了 Docker 镜像方案，改为由**控制节点校验并向目标节点分发离线 tar 归档**。

### 4.1 两类归档的构建

**diagnostic-tools**：16 个用户态诊断命令。构建时在 Ubuntu 22.04 容器里用 apt 安装对应的软件包，再把二进制连同它们的私有动态库一起拷贝到归档中：

- `cp -L` 解引用符号链接，二进制进 `bin/`；
- 对每个二进制跑 `ldd`，跳过动态链接器和 glibc 家族（libc/libm/libpthread 等，由目标系统提供），其余私有库拷进 `lib/`；
- `patchelf --set-rpath '$ORIGIN/../lib'` 让二进制只从包内找私有库。

在 22.04 上构建是为了 glibc 向下兼容（22.04 和 24.04 的目标节点通用）。构建时还会在包里写入一份 `BUILD-INFO.txt`，明确声明**不含** NVIDIA 驱动、CUDA toolkit、OFED（RDMA 驱动栈）、固件、内核模块——这些属于被检对象，由目标环境提供，缺失时应由检查报错暴露，而不是由工具包代为提供。

**nccl-tests**：用 `nvidia/cuda:<ver>-devel-ubuntu<ver>` 做基础镜像，从源码编译固定版本的 NCCL（v2.30.7，固定到 commit）、nccl-tests（v2.19.7）和 Open MPI（4.1.6，tarball 固定 SHA-256）。克隆源码时同时核对 tag 和 commit，不使用浮动引用。产物里 `libnccl.so.2`、`libcudart.so` 和 Open MPI 一并打入，同样用 `patchelf` 把 rpath 改成 `$ORIGIN` 相对路径。针对 Ubuntu 22.04 和 24.04 分别构建一份归档，文件名包含完整版本信息：

```text
nccl-tests-2.19.7-nccl-2.30.7-cuda13.0-ubuntu22.04-amd64.tar.gz
```

### 4.2 清单与指纹分离

离线包的信息拆成两份文件，职责不同：

- **清单 manifest**（`ansible/offline_packages/manifests/target-node-ubuntu.yml`）纳入 Git 版本管理，声明每个包的 `filename`、适用角色（cpu/gpu）、适用 OS 版本和架构、安装目的地、`required_paths` 等。它**故意不含 size/sha256**——完整性数据是构建期事实，不该手工维护。
- **checksums.json** 由 `build/lib/generate-checksums.py` 在每个归档构建完成后重新扫描生成，记录 size + sha256。它和归档一起被 gitignore，不纳入版本管理。

`make packall` 装配交付包时强制执行 `--check`：manifest 声明的每个 `filename` 必须存在于磁盘，且重新计算的 size/sha256 与 checksums.json 一致，否则装配直接失败——这里只校验，不会重新生成指纹。

### 4.3 校验、按需分发与安装

分发由 `02_offline_tools` role 完成，流程如下：

1. **控制节点校验**：`validate_offline_tools.py` 读取 manifest，按目标节点的 OS/版本/架构/角色过滤出适用的包，重算归档的 size + sha256 比对 checksums.json，并做 tar 成员安全审计——拒绝绝对路径、`..`、符号链接、硬链接和设备节点（这也是构建端要 `cp -L` 并删掉所有链接的原因）。安装目的地限制在 `/opt/` 子目录。
2. **按需分发**：并非在检查开始前向所有节点全量分发。diagnostic-tools 在检查流程的初始阶段分发给全部节点；nccl-tests 只在 GPU 节点通过驱动、CUDA、Fabric Manager（NVSwitch fabric 管理服务）等前置资格检查、且显式授权主动测试（`bmc_allow_active_tests=true`）后才按需分发，CPU 节点不会收到这个包。
3. **幂等安装**：目标节点上留有 `.bare-metal-check-<name>-<version>.sha256` 摘要标记，一致则跳过传输；需要安装时先传到 `/tmp` 暂存，**目标端二次校验** size + sha256 后才解包到 `/opt/bare-metal-check-tools` 或 `/opt/nccl-tests`，最后逐个断言 `required_paths` 存在且可执行，写回安装回执。

状态语义也做了区分：控制节点预检时全量校验失败只发**预警**，不中断基础检查；真正请求该归档的环节遇到缺失、摘要错误、传输或安装失败才记 **ERROR**；工具运行之后性能不达标则记为 **FAIL**。三种情况对应不同的结果状态，在报告中可以区分。

## 5. HTML 报告：单文件自包含 + 数据独立

报告是这个工具的最终产出，而查看报告的现场机器同样可能离线、没有 Node、甚至没有 Python。HTML 报告的方案是：**构建期与生成期分离，模板一次构建，数据逐次注入**。

### 5.1 单文件模板

前端是 Vue 3 + Vite 工程（`reports/html/`），构建时用 [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) 把全部 JS/CSS 内联，配合 `cssCodeSplit: false` 和把 `assetsInlineLimit` 设为一个足够大的值，产出零外部请求的单个 HTML。构建在容器里完成（同一个 `common` builder 镜像里有 Node 20），产物叫 `viewer-template.html`——注意是「模板」，不是报告。

模板里预留了一个数据占位符：

```html
<script type="application/json" id="report-data">__BASE64_REPORT_DATA__</script>
```

### 5.2 base64 数据岛

检查结束后，pyz 里的 Python 代码（`src/bare_metal_check/html_report.py`）把本次的 `run.json` 做 base64 编码，用锚定到该 script 标签的正则精确替换占位符，产出 `runtime/results/<run_id>/reports/<run_id>.html`。

为什么用 base64 而不是直接内嵌 JSON？两个原因：JSON 内容里如果出现 `</script>` 会破坏 HTML 解析，base64 字符集天然安全；另外现场只有 shell 时，`base64` + `sed` 也能手工完成注入，不依赖 Python 的模板引擎。前端读取时用 `<script type="application/json">` 作为纯数据容器——浏览器不会执行这个标签里的内容，这种把数据嵌入 HTML 的做法也叫数据岛（data island）——`atob` 解码后再经 `TextDecoder` 还原 UTF-8，避免中文乱码。

「数据独立」体现在：**模板和数据各自演进、互不依赖**。模板随交付包一次分发，每批次检查产出的 JSON 独立注入，同一份模板可以生成任意多份报告。

### 5.3 file:// 与 http:// 两种访问

- **`file://`**：因为所有 JS/CSS/字体都内联、数据在 DOM 数据岛里、全程没有 fetch/XHR，浏览器双击打开 HTML 就能完整查看。这不是绕过了浏览器的 file:// 安全限制，而是架构上不存在跨域请求。报告文件可以直接拷贝、归档或通过邮件发送。
- **`http://`**：`run` 命令完成后，CLI 用标准库 `http.server.SimpleHTTPRequestHandler` 启动一个临时静态服务——socket 绑定端口 0 让 OS 分配空闲端口，监听 `0.0.0.0` 并打印所有本机局域网地址的 URL，方便同事直接从自己的浏览器访问。没有任何自定义路由，因为数据已经内联，服务只需要顺带提供同目录 Excel 报告的下载。页面用 `window.location.protocol` 判断协议，http 模式下才显示「下载报告 / 下载 Excel」按钮；服务随 CLI 进程退出而关闭，长期留存靠单文件 HTML 本身。

Excel 报告有意**不**嵌进 HTML，作为同目录的独立文件通过相对链接引用，保持 HTML 体积小、职责单一。

## 6. 其他值得一提的点

- **可复现性**：所有 tar 包固定 `SOURCE_DATE_EPOCH`、`--sort=name`、`--owner=0`；依赖由 `uv.lock` 锁定；uv 版本固定在 Dockerfile 里；源码依赖固定到 commit 并校验哈希；镜像 tag 由 Dockerfile 内容派生。目标是同一份代码在任何时候构建出的交付包逐字节一致。
- **安全边界**：离线包只接受 tar 系格式、拒绝链接和设备节点、目的地限 `/opt/`、不执行包内任何安装脚本、不跑 apt/rpm。校验逻辑集中在控制节点一侧的单个 Python 脚本里，便于审计。

## 7. 小结

这套方案的核心思路是把「自包含」贯彻到交付流程的每一层：CLI 用 shiv 把 Ansible 一起打成 pyz 单文件，运行期再靠 `SHIV_CONSOLE_SCRIPT` 让同一份 pyz 切换出 Ansible 的各个入口；目标节点上的检查工具以「构建期指纹 + 运行期校验 + 按需分发」的离线归档形式送达；报告则通过单文件模板 + base64 数据岛做到构建期与生成期分离，`file://` 双击即可查看，`http://` 便于在局域网内分享。整个流程对现场环境的要求降到了一个 Python 3 解释器和一个浏览器。
