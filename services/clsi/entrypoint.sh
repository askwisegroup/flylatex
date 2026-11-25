#!/bin/sh

# FIXED: 2026-11-03 分离模式（web + clsi 两个容器）下 clsi 容器默认不挂 docker.sock，
#   原来无条件 stat docker.sock，会拿到空 gid → groupadd/usermod 失败并输出噪音错误。
#   DockerRunner（一次性编译容器）才需要 docker.sock，这里改成按需处理。
# OLD:
#   DOCKER_GROUP=$(stat -c '%g' /var/run/docker.sock)
#   groupadd --non-unique --gid ${DOCKER_GROUP} dockeronhost
#   usermod -aG dockeronhost node
if [ -S /var/run/docker.sock ]; then
  DOCKER_GROUP=$(stat -c '%g' /var/run/docker.sock)
  groupadd --non-unique --gid "${DOCKER_GROUP}" dockeronhost 2>/dev/null || true
  usermod -aG dockeronhost node 2>/dev/null || true
fi

# compatibility: initial volume setup
mkdir -p /overleaf/services/clsi/cache && chown node:node /overleaf/services/clsi/cache
mkdir -p /overleaf/services/clsi/compiles && chown node:node /overleaf/services/clsi/compiles
mkdir -p /overleaf/services/clsi/db && chown node:node /overleaf/services/clsi/db
mkdir -p /overleaf/services/clsi/output && chown node:node /overleaf/services/clsi/output

exec runuser -u node -- "$@"
