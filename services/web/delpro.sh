#!/bin/bash

# 使用pgrep查找运行web/app.js的进程ID
pids=$(pgrep -f "/overleaf/services/web/app.js")

# 使用kill命令结束这些进程
for pid in $pids
do
  echo "Killing process $pid"
  kill -9 $pid
done