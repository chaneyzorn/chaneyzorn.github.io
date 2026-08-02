# AGENTS.md

## 项目概述

个人博客「Chaney's MoonBook」，基于 [Hugo](https://gohugo.io/) 静态站点生成器 + [PaperMod](https://github.com/adityatelange/hugo-PaperMod) 主题，部署在 GitHub Pages（<https://chaneyzorn.github.io>）。内容以中文为主。

## 技术栈与环境

- Hugo **extended** 版，CI 使用 `0.160.1`（见 `.github/workflows/hugo.yaml`），本地版本应尽量一致
- 需要 Dart Sass（PaperMod 主题编译资源用）
- 主题通过 **git submodule** 挂载在 `themes/PaperMod`，克隆后必须执行：

  ```sh
  git submodule update --init --recursive
  ```

## 常用命令

快捷指令已收录在 `justfile`（需安装 [just](https://github.com/casey/just)），用 `just --list` 查看：

```sh
just serve          # 本地预览（含草稿），绑定 0.0.0.0 供局域网远程访问
just new codes xxx  # 按 archetypes/default.md 模板新建文章
just build          # 生产构建，输出到 public/
just verify         # 校验构建：hugo --gc --minify -d /tmp/hugo-verify
just lint           # markdown lint（rumdl，配置见 rumdl.toml）
just lint-fix       # 自动修复可修复的 lint 问题
just theme-update   # 更新 PaperMod 主题 submodule 到上游最新
```

**校验构建务必用 `just verify`（即 `hugo --gc --minify -d /tmp/hugo-verify`）**：直接
`hugo --gc --minify` 会覆盖 `public/`，与用户正在运行的 `hugo server` 相互干扰。
本地验证构建一律输出到 `/tmp` 下的临时目录，不碰 `public/`。

markdown lint 使用 [rumdl](https://github.com/rvben/rumdl)，配置在 `rumdl.toml`
（中文长文关闭了 MD013 行长限制）。

## 目录结构

- `hugo.yaml` — 站点主配置（YAML 格式，注意不是 TOML）
- `content/posts/` — 随笔/生活类文章
- `content/codes/` — 技术类文章
- `archetypes/default.md` — 新文章的 front matter 模板
- `layouts/_default/rss.xml` — 对主题 RSS 模板的自定义覆盖
- `layouts/_partials/header.html` — 覆盖主题头部模板：菜单图标（`.Pre`）移出 `span.active`，使当前页高亮只包文字（主题升级时需人工同步）
- `layouts/_partials/extend_footer.html` — 主题的自定义注入点：窄屏滚动方向感知的导航自动显隐 JS（配合 accent.css 的 `.scroll-down` 规则）
- `assets/css/extended/accent.css` — 自定义设计系统（配色/字体/导航/列表等），PaperMod 会在主题样式之后自动加载
- `assets/css/includes/chroma-styles.css` — 亮/暗双主题代码高亮，覆盖主题同名文件（亮色 solarized-light + 暗色 gruvbox，暗色红色有手工补丁，见文件头注释）
- `assets/js/fastsearch.js` — 搜索结果渲染的自定义 fork（标题+摘要/命中上下文+关键字高亮），覆盖主题同名文件，**主题升级时需人工同步**
- `static/` — 静态资源（`cm/` 图片、`favicon_io/` 图标）
- `themes/PaperMod` — 主题 submodule，**不要直接修改主题内文件**；需要覆盖时在 `layouts/` 或 `assets/` 下按相同路径新建文件（Hugo union 文件系统，项目优先）

## 内容写作约定

- 文章 front matter 遵循 `archetypes/default.md`：`title`、`date`、`isCJKLanguage: true`、`draft`、`tags` 为必填/常用字段
- 新建文章默认 `draft: true`，发布前改为 `false`
- 新建文章统一使用 **page bundle** 形式：建目录 `content/<section>/<slug>/`，内含 `index.md`；有图片等资源时在同一目录下建 `asserts/`（本项目资源目录习惯命名为 `asserts/`，引用时注意保持一致的拼写），并在 front matter 中设置 `cover.relative: true`。历史遗留的单文件 `content/<section>/<slug>.md` 保持现状，后续若迁移可顺手改为 page bundle
- 图片引用支持 `#center` 等 PaperMod 的 URL fragment 样式
- 代码高亮使用 Chroma（`markup.highlight` 配置），支持 `hl_lines` 等属性

## 部署

- push 到 `main` 分支触发 `.github/workflows/hugo.yaml`，自动构建并部署到 GitHub Pages
- 无需本地手动发布；本地改动验证通过（`hugo --gc --minify -d /tmp/hugo-verify` 构建成功）即可提交

## 修改注意事项

- 不要修改 `themes/PaperMod/` 下的任何文件（submodule 内容，改动不会生效且会污染状态）
- 改配置时编辑 `hugo.yaml`，PaperMod 可用参数参考其官方 wiki
- 内容文件改动属于数据变更，一般不涉及代码逻辑；不要为文章写作引入额外工具链
