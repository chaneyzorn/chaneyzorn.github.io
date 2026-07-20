# Chaney's MoonBook

何夜无月 逝者如斯

homepage: <https://chaneyzorn.github.io>

hugo: <https://gohugo.io/>

hugo-PaperMod: <https://github.com/adityatelange/hugo-PaperMod>

## 快速开始

### 环境准备

- Hugo **extended** 版，建议 `0.160.1`（与 CI 保持一致，见 `.github/workflows/hugo.yaml`）
- Dart Sass（PaperMod 主题编译资源用）

### 拉取代码（含主题 submodule）

主题 PaperMod 以 git submodule 方式挂载在 `themes/PaperMod`。

```sh
# 首次克隆
git clone --recurse-submodules https://github.com/chaneyzorn/chaneyzorn.github.io.git

# 已克隆但未初始化 submodule
git submodule update --init --recursive

# 将主题更新到上游最新（会改变 submodule 锁定的提交，需随后提交该变更）
git submodule update --remote --merge
```

### 本地预览

```sh
# 含草稿，监听本机回环地址
hugo server -D

# 绑定 0.0.0.0，供局域网内其他设备远程访问
hugo server -D --bind 0.0.0.0 --port 1313 \
  --baseURL "http://$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]; exit}'):1313/"
```

浏览器访问 <http://localhost:1313/>（远程访问则换成机器 IP）。

### 写新文章

```sh
hugo new posts/<slug>.md    # 或 codes/<slug>.md
```

新文章默认 `draft: true`，发布前改为 `false`。

### 发布

push 到 `main` 分支即可。GitHub Actions 工作流（`.github/workflows/hugo.yaml`）会自动构建并部署到 GitHub Pages，无需本地手动发布。

也可在 Actions 页面手动触发（workflow_dispatch）。
