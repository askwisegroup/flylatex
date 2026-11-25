#!/bin/bash
# 在宿主机上运行（需要 docker CLI）：把现有 sharelatex 镜像原地升到新的 TeX Live，
# 再用 docker export/import 压平成「单层、只含一份 TeX Live」的新镜像。
#
#   ./build_texlive_image.sh                 # 用默认容器/标签
#   IMAGE=... SRC_CONTAINER=... NEW_TAG=... ./build_texlive_image.sh
#   SKIP_UPGRADE=1 ./build_texlive_image.sh  # 只压平，不升级（验证脚本本身）
#
# 为什么不是 Dockerfile：
#   当前镜像 `docker history` 只有 1 层 8.27GB（import 压平过的），TeX Live 2023
#   的 4.3GB 固化在那一层里。子层 `rm -rf` 只会加 whiteout，父层字节永远保留，
#   新镜像 = 8.27G + 新树 ≈ 13GB，一份可见、一份死重。
#   export 走的是容器的真实文件系统：删掉的文件在导出物里不存在，import 出来的
#   单层镜像里就只有一份树（≈ 非 TeX 部分 + 新树）。
#
# 会做什么：
#   1. 备份旧镜像（打 KEEP_TAG）并记录元数据（Env/Cmd/Entrypoint/…）
#   2. 起一个 entrypoint=bash 的一次性容器（不启动 my_init / nginx / web）
#   3. 容器内：update-tlmgr-latest.sh --update → tlmgr update --all
#              → mktexlsr / fmtutil-sys --all / updmap-sys / luaotfload-tool / fc-cache
#   4. 断言 release-texlive.txt 已是目标年份、pdflatex 能跑
#   5. docker export | docker import（自动补回元数据）→ 新 tag
#   6. 逐字段校验新镜像配置 == 原镜像配置（不一致直接报错退出）
#   7. 打印新旧体积对比，删除临时容器
#
# 重要：修配置不能用 `docker commit`
#   docker commit 会继承**容器**的 Config（带着你 --entrypoint 覆盖的 ENTRYPOINT、
#   带着 `-c true` 之类的 CMD），再把 --change 叠上去。实测踩过：
#     docker create --entrypoint bash IMG -c true && docker commit IMG IMG
#   → 镜像 ENTRYPOINT 变成 ["bash"]，容器启动等于 `bash /sbin/my_init`，
#     python 脚本被 bash 逐行执行（import os → /usr/bin/import 报 X server 错），
#     容器无限重启、线上 502。
#   export/import 只取文件系统，容器 Config 完全不参与，所以本脚本用
#   `--entrypoint bash` 起临时容器是安全的。
#   万一压平后的配置错了，正确修法是 `docker build` 重写 ENTRYPOINT：
#     printf 'FROM %s\nENTRYPOINT []\nCMD ["/sbin/my_init"]\n' "$IMG" > /tmp/Df
#     docker build -t IMG -f /tmp/Df /tmp     # `--change 'ENTRYPOINT []'` 在 commit 里不生效
#
# 会丢的（docker import 的固有限制，脚本会提示）：
#   - HEALTHCHECK：无法用 --change 恢复 → 写进 docker-compose 的 healthcheck:
#   - Created / Author / History / OnBuild：镜像元数据，不影响运行
#   - 层结构：压平成单层（这正是目的）
#
# 不会做什么：不动线上容器、不 restart、不改 compose、不删旧镜像。

set -euo pipefail

SRC_CONTAINER="${SRC_CONTAINER:-sharelatex}"
IMAGE="${IMAGE:-$(docker inspect "$SRC_CONTAINER" --format '{{.Config.Image}}')}"
# TARGET_RELEASE 必须先赋值：下面两个默认 tag 名要用到它
TARGET_RELEASE="${TARGET_RELEASE:-2026}"
NEW_TAG="${NEW_TAG:-${IMAGE}-tl${TARGET_RELEASE}}"
KEEP_TAG="${KEEP_TAG:-${IMAGE}-pre-tl${TARGET_RELEASE}}"
TMP_CONTAINER="${TMP_CONTAINER:-tl-upgrade-tmp}"
KEEP_TMP=0
MIRROR="${MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet}"
SKIP_UPGRADE="${SKIP_UPGRADE:-0}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$KEEP_TMP" = "1" ]; then
    echo "临时容器 $TMP_CONTAINER 已保留，排查完执行：docker rm -f $TMP_CONTAINER"
    return
  fi
  docker rm -f "$TMP_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "源镜像：$IMAGE"
log "新标签：$NEW_TAG   备份标签：$KEEP_TAG"

# ---------- 0. 预检 ----------
log "0/6 预检"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "找不到镜像 $IMAGE"

if docker ps -a --format '{{.Names}}' | grep -qx "$TMP_CONTAINER"; then
  die "已存在名为 $TMP_CONTAINER 的容器，请先 docker rm -f $TMP_CONTAINER"
fi

OLD_SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}')
OLD_MB=$((OLD_SIZE / 1024 / 1024))
echo "    旧镜像大小：${OLD_MB}MB（$OLD_SIZE 字节）"

# export/import 期间要**同时**存在旧镜像和新镜像，所以可用空间至少得
# 装下一份同量级的镜像（升级再加约 1.5GB）。不够就直接停，别等 import
# 写到一半 "no space left on device" 留下半成品镜像。
NEED_MB=$((OLD_MB * 11 / 10 + 1536))
# `|| true`：/var/lib/docker 不存在时 df 返回非 0，pipefail 下会让脚本直接退出
FREE_KB=$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}' || true)
if [ -n "${FREE_KB:-}" ]; then
  FREE_MB=$((FREE_KB / 1024))
  echo "    /var/lib/docker 可用空间：$((FREE_MB / 1024))GB（需要约 $((NEED_MB / 1024))GB）"
  if [ "$FREE_MB" -lt "$NEED_MB" ]; then
    if [ "${FORCE:-0}" = "1" ]; then
      echo "    警告：空间不足，但你设了 FORCE=1，继续"
    else
      cat >&2 <<EOM
空间不足，已中止（旧镜像 ${OLD_MB}MB，需要约 $((NEED_MB / 1024))GB 可用）。

先回收空间，再重跑。查看可回收项：
    docker system df -v            # 看 UNIQUE SIZE 列，哪些镜像占了空间
    docker image prune -a          # 只删「无 tag 且无容器引用」的悬空镜像，很安全

确认无误后重跑；确实要在空间不足时硬来：FORCE=1 ./build_texlive_image.sh
EOM
      exit 1
    fi
  fi
fi

# ---------- 1. 备份旧镜像 ----------
log "1/6 给旧镜像打备份标签 $KEEP_TAG"
docker tag "$IMAGE" "$KEEP_TAG"
echo "    回滚方式：docker tag $KEEP_TAG $IMAGE"

# ---------- 2. 收集元数据（import 会丢，必须补回） ----------
log "2/6 收集原镜像元数据"
CHANGE_ARGS=()
collect() {
  while IFS= read -r line; do
    if [ -n "$line" ]; then CHANGE_ARGS+=("-c" "$line"); fi
  done
}

# ENV 的值里带空格时必须加引号，否则 docker import 只吃到第一个空格
collect_env() {
  while IFS= read -r kv; do
    if [ -z "$kv" ]; then continue; fi
    key="${kv%%=*}"
    val="${kv#*=}"
    # 一律加双引号：Dockerfile 的词法分析会剥掉值里的 " 和 \，也会把 $ 当变量展开，
    # 所以三个字符都要转义。之前只在「含空格」时才加引号，导致
    # SHARELATEX_RIGHT_FOOTER=[{"text":"x"}] 被吃成 [{text:x}]。
    esc=$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g')
    CHANGE_ARGS+=("-c" "ENV ${key}=\"${esc}\"")
  done
}

collect_env <<EOF
$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{.}}{{println}}{{end}}')
EOF

# LABEL 也一样要处理引号
while IFS=$'\t' read -r lk lv; do
  if [ -z "${lk:-}" ]; then continue; fi
  esc=$(printf '%s' "$lv" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g')
  CHANGE_ARGS+=("-c" "LABEL ${lk}=\"${esc}\"")
done < <(docker image inspect "$IMAGE" --format '{{range $k, $v := .Config.Labels}}{{$k}}{{"\t"}}{{$v}}{{println}}{{end}}')
ENTRYPOINT_JSON=$(docker image inspect "$IMAGE" --format '{{json .Config.Entrypoint}}')
CMD_JSON=$(docker image inspect "$IMAGE" --format '{{json .Config.Cmd}}')
WORKDIR=$(docker image inspect "$IMAGE" --format '{{.Config.WorkingDir}}')
USERNAME=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')
STOPSIGNAL=$(docker image inspect "$IMAGE" --format '{{.Config.StopSignal}}')

# 注意：不能用 `[ ... ] && arr+=(...)` 的写法，set -e 下条件不成立会直接退出脚本
if [ "$ENTRYPOINT_JSON" != "null" ]; then CHANGE_ARGS+=("-c" "ENTRYPOINT $ENTRYPOINT_JSON"); fi
if [ "$CMD_JSON" != "null" ]; then CHANGE_ARGS+=("-c" "CMD $CMD_JSON"); fi
if [ -n "$WORKDIR" ]; then CHANGE_ARGS+=("-c" "WORKDIR $WORKDIR"); fi
if [ -n "$USERNAME" ]; then CHANGE_ARGS+=("-c" "USER $USERNAME"); fi
if [ -n "$STOPSIGNAL" ]; then CHANGE_ARGS+=("-c" "STOPSIGNAL $STOPSIGNAL"); fi

collect <<EOF
$(docker image inspect "$IMAGE" --format '{{range $p, $_ := .Config.ExposedPorts}}EXPOSE {{$p}}{{println}}{{end}}')
EOF

# VOLUME 是镜像级声明，不补回会导致 compose 里依赖匿名卷的行为变化
collect <<EOF
$(docker image inspect "$IMAGE" --format '{{range $v, $_ := .Config.Volumes}}VOLUME {{$v}}{{println}}{{end}}')
EOF

# HEALTHCHECK 无法通过 docker import --change 恢复，只能提示
HEALTH_JSON=$(docker image inspect "$IMAGE" --format '{{json .Config.Healthcheck}}')
if [ -n "$HEALTH_JSON" ] && [ "$HEALTH_JSON" != "null" ]; then
  echo "    警告：原镜像带 HEALTHCHECK（$HEALTH_JSON）"
  echo "          docker import 恢复不了，需要写进 docker-compose 的 healthcheck:"
fi

printf '    将补回 %d 条元数据：\n' "${#CHANGE_ARGS[@]}"
printf '      %s\n' "${CHANGE_ARGS[*]:0:12}"
if [ "${#CHANGE_ARGS[@]}" -gt 12 ]; then echo "      ...（共 ${#CHANGE_ARGS[@]} 段）"; fi

# ---------- 3. 起一次性容器 ----------
log "3/6 启动一次性容器 $TMP_CONTAINER（entrypoint=bash，不启动任何服务）"
# --user root：镜像若声明了 USER，tlmgr 会因权限不足失败
# --rm：容器停止时连匿名卷一起清掉
docker run -d --rm --user root --name "$TMP_CONTAINER" --entrypoint bash "$IMAGE" -c 'sleep infinity' >/dev/null

# ---------- 4. 升级 ----------
if [ "$SKIP_UPGRADE" = "1" ]; then
  log "4/6 跳过升级（SKIP_UPGRADE=1）"
else
  log "4/6 容器内升级 TeX Live → $TARGET_RELEASE"
  if ! docker exec "$TMP_CONTAINER" bash -lc "
    set -e
    cd /tmp
    echo '--- 当前版本 ---'
    head -1 /usr/local/texlive/*/release-texlive.txt 2>/dev/null || true

    echo '--- 换成目标版本的 tlmgr ---'
    curl -fsSLO $MIRROR/update-tlmgr-latest.sh
    # update-tlmgr-latest.sh 是 makeself 自解压包：它自己只认 --confirm/--target 等，
    # 传给内嵌脚本的参数必须放在 `--` 之后。不同 TL 版本的 makeself 生成器行为不同，
    # 两种写法都试一遍，都不认就报错退出。
    if sh update-tlmgr-latest.sh -- --update; then
      echo '   (以 `-- --update` 方式更新 tlmgr 成功)'
    elif sh update-tlmgr-latest.sh --update; then
      echo '   (以 `--update` 方式更新 tlmgr 成功)'
    else
      echo 'ERROR: update-tlmgr-latest.sh 两种参数写法都失败' >&2
      echo '       在容器里手动执行 `sh update-tlmgr-latest.sh --list` 看内嵌脚本，' >&2
      echo '       或 `sh update-tlmgr-latest.sh --noexec --keep --target /tmp/x` 解开后手动跑' >&2
      exit 1
    fi
    tlmgr --version | head -1

    echo '--- 推整棵树 ---'
    tlmgr option repository $MIRROR
    tlmgr update --all || tlmgr update --all

    echo '--- 重建格式与缓存（跨版本必做）---'
    mktexlsr
    fmtutil-sys --all
    updmap-sys || echo 'warn: updmap-sys 失败，单项目编译通常不影响'
    luaotfload-tool --update || echo 'warn: luaotfload 缓存更新失败'
    fc-cache -f || true

    # tlmgr update --all 装进来的包，它的可执行文件不会自动出现在 /usr/local/bin：
    # 这个镜像原本只软链了 74 个（tlmgr path add 的产物），升级后 bin 目录里有 500+ 个，
    # 差的 441 个全在 PATH 里找不到——其中包括 biber（biblatex 用户的参考文献直接空）。
    echo '--- 补齐 /usr/local/bin 软链 ---'
    tlmgr path add
    for b in biber bibtex makeindex xindy dvipng dvisvgm latexmk; do
      command -v "$b" >/dev/null || echo "warn: $b 仍不在 PATH"
    done

    rm -f /tmp/update-tlmgr-latest.sh

    echo '--- 验收 ---'
    head -1 /usr/local/texlive/*/release-texlive.txt
    pdflatex --version | head -1
    xelatex --version | head -1
    tlmgr --version
  "; then
    KEEP_TMP=1
    die "容器内升级失败。临时容器已保留，可进去复跑那几条命令排查"
  fi
fi

# ---------- 5. 断言 ----------
log "5/6 断言目标版本"
ACTUAL_RELEASE=$(docker exec "$TMP_CONTAINER" bash -lc 'head -1 /usr/local/texlive/*/release-texlive.txt' | grep -o '[0-9]\{4\}' | head -1 || true)
echo "    容器内 release：${ACTUAL_RELEASE:-unknown}（目标 $TARGET_RELEASE）"
if [ "$SKIP_UPGRADE" != "1" ] && [ "$ACTUAL_RELEASE" != "$TARGET_RELEASE" ]; then
  die "升级没有生效（release=${ACTUAL_RELEASE:-unknown}）。临时容器保留，可进去手动排查；排查完 docker rm -f $TMP_CONTAINER"
fi
docker exec "$TMP_CONTAINER" bash -lc 'command -v pdflatex && pdflatex --version | head -1' \
  || die "容器内 pdflatex 不可用"

# 关键可执行文件必须在 PATH 里，否则 Overleaf 的编译链会静默失败
# （biber 缺失的表现是「引用渲染成 [key]、参考文献列表为空」，不报编译错）
MISSING_BINS=$(docker exec "$TMP_CONTAINER" bash -lc '
  for b in biber bibtex makeindex xindy dvipng dvisvgm latexmk pdflatex xelatex lualatex; do
    command -v "$b" >/dev/null || echo "$b"
  done' || true)
if [ -n "$MISSING_BINS" ]; then
  KEEP_TMP=1
  echo "    缺失：$(echo $MISSING_BINS)"
  die "有可执行文件不在 PATH（多半是没跑 tlmgr path add）。临时容器已保留"
fi
echo "    ✓ biber/bibtex/makeindex/xindy/dvipng/dvisvgm/latexmk/引擎 均在 PATH"

# 导出前清掉运行时垃圾：这些是容器里编译/下载的临时文件，export 会把它们一并固化进镜像
log "6/6 清理临时文件（/tmp /root/.cache /root/.npm /var/log）"
docker exec "$TMP_CONTAINER" bash -lc '
  rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null || true
  rm -rf /root/.cache /root/.npm 2>/dev/null || true
  find /var/log -type f -exec truncate -s 0 {} + 2>/dev/null || true
' >/dev/null 2>&1 || echo "    清理时有个别文件删不掉，忽略"

# ---------- 6. 压平 ----------
log "6/6 压平成单层镜像 $NEW_TAG（旧树在这一步真正消失）"
# 空数组在 bash < 4.4 + set -u 下会报错，这里显式兜一层
docker export "$TMP_CONTAINER" | docker import ${CHANGE_ARGS[@]+"${CHANGE_ARGS[@]}"} - "$NEW_TAG"

# ---------- 6b. 配置自检 ----------
# 压平最容易出事的地方不是文件系统，而是容器启动配置（ENTRYPOINT / CMD）。
# 配置漂移在镜像层面看不出来，要等容器起来无限重启才发现 → 这里直接拦住。
log "校验：新镜像配置必须与原镜像逐字段一致"
CONFIG_DIFF=0
cmp_field() {
  local name="$1" fmt="$2" a b
  a=$(docker image inspect "$IMAGE" --format "$fmt" 2>/dev/null | sort)
  b=$(docker image inspect "$NEW_TAG" --format "$fmt" 2>/dev/null | sort)
  if [ "$a" != "$b" ]; then
    CONFIG_DIFF=1
    echo "    [差异] $name"
    diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | sed 's/^/      /' || true
  fi
}
cmp_field ENV        '{{range .Config.Env}}{{.}}{{println}}{{end}}'
cmp_field LABEL      '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}'
cmp_field EXPOSE     '{{range $p, $_ := .Config.ExposedPorts}}{{$p}}{{println}}{{end}}'
cmp_field VOLUME     '{{range $v, $_ := .Config.Volumes}}{{$v}}{{println}}{{end}}'
cmp_field ENTRYPOINT '{{json .Config.Entrypoint}}'
cmp_field CMD        '{{json .Config.Cmd}}'
cmp_field WORKDIR    '{{.Config.WorkingDir}}'
cmp_field USER       '{{.Config.User}}'
cmp_field STOPSIGNAL '{{.Config.StopSignal}}'

if [ "$CONFIG_DIFF" != "0" ]; then
  echo
  echo "    新镜像配置与旧镜像不一致，**不要**改 compose 切过去。"
  echo "    排查：docker image inspect $NEW_TAG --format '{{json .Config}}'"
  die "配置自检未通过（新 tag 已生成但不建议使用：$NEW_TAG）"
fi
echo "    ✓ ENV/LABEL/ENTRYPOINT/CMD/WORKDIR/USER/STOPSIGNAL/EXPOSE/VOLUME 全部一致"

NEW_SIZE=$(docker image inspect "$NEW_TAG" --format '{{.Size}}')
NEW_LAYERS=$(docker image inspect "$NEW_TAG" --format '{{len .RootFS.Layers}}')
log "完成"
echo "    旧：$((OLD_SIZE / 1024 / 1024))MB"
echo "    新：$((NEW_SIZE / 1024 / 1024))MB（$NEW_LAYERS 层）"
echo "    备份镜像：$KEEP_TAG"
cat <<'EOT'

下一步（手动确认后再执行）：
  0. 上面已自动校验过配置一致性；如需人工复核：
     diff <(docker image inspect <旧tag> --format '{{json .Config}}' | python3 -m json.tool) \
          <(docker image inspect <新tag> --format '{{json .Config}}' | python3 -m json.tool)
  0b. 冒烟启动（不碰线上容器、不带端口/网络，只看 my_init 能不能正常跑）：
     timeout 25 docker run --rm --network none <新tag> 2>&1 | head -40
     判据：不能出现 'syntax error' 或 'import-im6.q16'；出现 mongo/redis 连接错误属正常
  1. 冒烟：docker run --rm --entrypoint bash <新tag> -c 'head -1 /usr/local/texlive/*/release-texlive.txt; pdflatex --version|head -1'
  2. 切流量：改 compose 的 image 为新 tag → docker compose up -d sharelatex
  3. 回滚：image 改回备份 tag → docker compose up -d sharelatex
  4. 确认无问题后，才 docker rmi 旧镜像以回收那 4.3GB 死重
  5. 需要分发到别的机器：docker push <新tag>
EOT
