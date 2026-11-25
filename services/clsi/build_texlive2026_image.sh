#!/bin/bash
# 兼容入口：脚本已改名为 build_texlive_image.sh（不锁年份），
# 本文件只做转发，保留旧名字避免历史文档/脚本失效。
#
#   TARGET_RELEASE=2027 ./build_texlive_image.sh
DIR=$(cd "$(dirname "$0")" && pwd)
echo "注意：build_texlive2026_image.sh 已改名为 build_texlive_image.sh，本文件仅转发。" >&2
exec "$DIR/build_texlive_image.sh" "$@"
