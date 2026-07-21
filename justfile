# 快捷指令集，使用 just（https://github.com/casey/just）
# 查看全部指令：just --list

# 本地预览（含草稿），绑定 0.0.0.0 供局域网远程访问；
# baseURL 主机默认自动探测本机 IP，也可手动指定：just serve 192.168.1.5
serve host="":
    #!/usr/bin/env bash
    ip="{{host}}"
    if [ -z "$ip" ]; then
        ip=$(ip -4 -o addr show scope global | awk '{split($4,a,"/");print a[1]; exit}')
    fi
    hugo server -D --bind 0.0.0.0 --port 1313 --baseURL "http://${ip}:1313/"

# 生产构建，输出到 public/
build:
    hugo --gc --minify

# 校验构建：输出到临时目录，不与运行中的 hugo server 互相干扰
verify:
    hugo --gc --minify -d /tmp/hugo-verify

# 新建文章：just new codes my-post
new section slug:
    hugo new {{section}}/{{slug}}.md

# markdown lint（配置见 rumdl.toml）
lint:
    rumdl check content/

# 自动修复可修复的 lint 问题
lint-fix:
    rumdl check --fix content/

# 更新 PaperMod 主题 submodule 到上游最新
theme-update:
    git submodule update --remote --merge
