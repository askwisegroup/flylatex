#!/bin/bash
# 先切到脚本自己所在的目录，这样在任意目录运行都行：
#   cd /overleaf          && ./services/web/rebuild_restart.sh
#   cd /overleaf/services && ./web/rebuild_restart.sh
#   cd .../services/web   && ./rebuild_restart.sh
#
# FIXED: 2026-11-16 加 set -euo + 构建后自检。
# 背景：原来没有 set -e，webpack 失败时脚本照样退出 0；上层 bin/update-sharelatex 只校验
# 「HEAD 对得上 + /health_check 200」，于是一路打印「升级完成」，但前端 bundle 还是旧的。
# 纯前端功能（多文件页签、AI 修复入口）永远不出现，排查很久才发现是构建没成。
set -euo pipefail

cd "$(dirname "$0")" || exit 1

export BROWSERSLIST_IGNORE_OLD_DATA=1

echo "== webpack:production @ $(git rev-parse --short HEAD 2>/dev/null || echo '?')$(git symbolic-ref --short -q HEAD 2>/dev/null | sed 's/^/ (branch: /;s/$/)/')"
npm run webpack:production -- --no-devtool

# 产物自检：manifest 必须是刚刚生成的，否则说明这次构建没真正跑完
node -e '
  const fs = require("fs")
  const manifest = "public/manifest.json"
  if (!fs.existsSync(manifest)) {
    console.error("✗ 找不到 " + manifest + "：webpack 没有产出")
    process.exit(1)
  }
  const ageMinutes = (Date.now() - fs.statSync(manifest).mtimeMs) / 60000
  if (ageMinutes > 15) {
    console.error(
      "✗ " + manifest + " 是 " + ageMinutes.toFixed(1) + " 分钟前的，本次构建没有更新产物"
    )
    process.exit(1)
  }
  const jsFiles = fs.readdirSync("public/js").filter(f => f.endsWith(".js"))
  console.log(
    "✓ 前端产物已更新（" + ageMinutes.toFixed(1) + " 分钟前），public/js 共 " +
      jsFiles.length + " 个文件"
  )
'

./delpro.sh
