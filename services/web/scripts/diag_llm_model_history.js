/**
 * 排查用：「AI 服务无响应（model not found: gpt-4o / HTTP 422）」时，
 * 回答"之前正常的时候到底在用哪个模型、什么时候开始失败的"。
 *
 * 数据来源是 llm_usage 集合（每次出网调用一行，含 model / status / billing），
 * 不需要网关、不需要日志文件、不改任何数据（只读）。
 *
 * 用法（容器内 /overleaf 目录）：
 *   node services/web/scripts/diag_llm_model_history.js            # 最近 24 小时
 *   node services/web/scripts/diag_llm_model_history.js --hours 72
 *   node services/web/scripts/diag_llm_model_history.js --failures 20
 */

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? Number(argv[index + 1]) : fallback
}

const HOURS = argValue('--hours', 24)
const FAILURES = argValue('--failures', 10)

const { getCollectionInternal } = require('../app/src/infrastructure/mongodb')

const pad = n => String(n).padStart(2, '0')
const fmt = at =>
  at
    ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
        at.getHours()
      )}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    : '-'

function printTable(rows) {
  const widths = [
    Math.max(4, ...rows.map(r => r.model.length)),
    Math.max(5, ...rows.map(r => String(r.calls).length)),
    Math.max(5, ...rows.map(r => String(r.failed).length)),
    Math.max(16, ...rows.map(r => fmt(r.firstCall).length)),
    Math.max(16, ...rows.map(r => fmt(r.lastCall).length)),
  ]
  const line = cells =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')

  console.log(line(['模型', '调用', '失败', '首次', '最近']))
  console.log(line(widths.map(w => '-'.repeat(w))))
  for (const row of rows) {
    console.log(
      line([row.model, row.calls, row.failed, fmt(row.firstCall), fmt(row.lastCall)])
    )
  }
}

async function main() {
  const collection = await getCollectionInternal('llm_usage')
  const since = new Date(Date.now() - HOURS * 60 * 60 * 1000)

  const rows = await collection
    .aggregate([
      { $match: { at: { $gte: since } } },
      {
        $group: {
          _id: { $ifNull: ['$model', '(未记录)'] },
          calls: { $sum: 1 },
          failed: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ['$status', null] },
                    { $lt: ['$status', 200] },
                    { $gte: ['$status', 300] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          firstCall: { $min: '$at' },
          lastCall: { $max: '$at' },
        },
      },
      { $sort: { lastCall: -1 } },
    ])
    .toArray()

  console.log(`llm_usage 最近 ${HOURS} 小时（只读）：\n`)
  if (rows.length === 0) {
    console.log('  没有任何调用记录 —— 说明请求根本没走到网关（鉴权/路由就失败了）')
  } else {
    printTable(
      rows.map(r => ({
        model: r._id,
        calls: r.calls,
        failed: r.failed,
        firstCall: r.firstCall,
        lastCall: r.lastCall,
      }))
    )
  }

  if (FAILURES > 0) {
    const failures = await collection
      .find({ at: { $gte: since }, $or: [{ status: { $gte: 400 } }] })
      .sort({ at: -1 })
      .limit(FAILURES)
      .project({ at: 1, model: 1, status: 1, billing: 1, source: 1, ms: 1 })
      .toArray()

    console.log(`\n最近的失败调用（最多 ${FAILURES} 条）：`)
    if (failures.length === 0) {
      console.log('  无')
    } else {
      for (const row of failures) {
        console.log(
          `  ${fmt(row.at)}  ${String(row.model).padEnd(18)} HTTP ${String(
            row.status
          ).padEnd(4)} billing=${row.billing || '-'} source=${row.source || '-'} ${
            row.ms != null ? row.ms + 'ms' : ''
          }`
        )
      }
    }
  }

  // 只有这一行能直接回答"进程当前配置的模型是什么"
  console.log(
    `\n当前进程环境：OPENAI_MODEL=${process.env.OPENAI_MODEL || '(未设置 → 代码默认 gpt-4o)'}`
  )
  console.log(
    `              OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL || '(未设置 → 默认网关)'}`
  )
  process.exit(0)
}

main().catch(error => {
  console.error('查询失败：', error.message)
  process.exit(1)
})
