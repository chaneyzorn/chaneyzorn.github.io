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

```sh
hugo server -D        # 本地预览（含草稿），默认 http://localhost:1313
hugo new posts/xxx.md # 按 archetypes/default.md 模板新建文章
hugo --gc --minify    # 生产构建，输出到 public/
```

## 目录结构

- `hugo.yaml` — 站点主配置（YAML 格式，注意不是 TOML）
- `content/posts/` — 随笔/生活类文章
- `content/codes/` — 技术类文章
- `archetypes/default.md` — 新文章的 front matter 模板
- `layouts/_default/rss.xml` — 对主题 RSS 模板的自定义覆盖
- `static/` — 静态资源（`cm/` 图片、`favicon_io/` 图标）
- `themes/PaperMod` — 主题 submodule，**不要直接修改主题内文件**；需要覆盖时在 `layouts/` 下按相同路径新建模板

## 内容写作约定

- 文章 front matter 遵循 `archetypes/default.md`：`title`、`date`、`isCJKLanguage: true`、`draft`、`tags` 为必填/常用字段
- 新建文章默认 `draft: true`，发布前改为 `false`
- 带图片等资源的文章使用 **page bundle** 形式：建目录 `content/<section>/<slug>/`，内含 `index.md` 与资源文件（本项目资源目录习惯命名为 `asserts/`，引用时注意保持一致的拼写），并在 front matter 中设置 `cover.relative: true`
- 无资源的纯文本文章直接用单文件 `content/<section>/<slug>.md`
- 图片引用支持 `#center` 等 PaperMod 的 URL fragment 样式
- 代码高亮使用 Chroma（`markup.highlight` 配置），支持 `hl_lines` 等属性

## 部署

- push 到 `main` 分支触发 `.github/workflows/hugo.yaml`，自动构建并部署到 GitHub Pages
- 无需本地手动发布；本地改动验证通过（`hugo --gc --minify` 构建成功）即可提交

## 修改注意事项

- 不要修改 `themes/PaperMod/` 下的任何文件（submodule 内容，改动不会生效且会污染状态）
- 改配置时编辑 `hugo.yaml`，PaperMod 可用参数参考其官方 wiki
- 内容文件改动属于数据变更，一般不涉及代码逻辑；不要为文章写作引入额外工具链
