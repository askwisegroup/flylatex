/**
 * Zero out the pre-2026-05 token estimates in `aichathistories`.
 *
 * Those rows were written before the AI stack read `usage` from the gateway: the
 * numbers came from a word-count formula (1.5 chars/token for CJK, 1.2 words for
 * English), so they never matched what the account was actually charged.
 *
 * From now on the only accepted values are:
 *   tokensCalculatedBy: 'api'      → tokens come from the gateway `usage` object
 *   tokensCalculatedBy: 'missing'  → the gateway returned no usage, values are 0
 *
 * This script rewrites legacy `wordcount` rows to `missing` with zeroed token
 * counts. Chat content, questions and timestamps are untouched — only the made-up
 * numbers go away, so any aggregate over this collection is uniformly "real".
 *
 * Usage:
 *   node scripts/migrate_ai_chat_legacy_token_estimates.js               # dry run
 *   node scripts/migrate_ai_chat_legacy_token_estimates.js --dry-run=false
 */

const { db } = require('../app/src/infrastructure/mongodb')
const { batchedUpdate } = require('./helpers/batchedUpdate')

const DRY_RUN = !process.argv.includes('--dry-run=false')
const LOG_EVERY_IN_S = parseInt(process.env.LOG_EVERY_IN_S, 10) || 5

async function main(DRY_RUN) {
  let processed = 0
  let tokensDropped = 0
  let lastLog = 0

  const logProgress = () => {
    console.log(
      `legacy wordcount rows ${processed} | tokens dropped ${tokensDropped}` +
        (DRY_RUN ? ' (dry run: nothing written)' : '')
    )
  }

  await batchedUpdate(
    'aichathistories',
    { tokensCalculatedBy: 'wordcount' },
    async rows => {
      if (!DRY_RUN) {
        await db.aichathistories.updateMany(
          { _id: { $in: rows.map(row => row._id) } },
          {
            $set: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              tokensCalculatedBy: 'missing',
            },
          }
        )
      }

      processed += rows.length
      tokensDropped += rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0)

      if (Date.now() - lastLog >= LOG_EVERY_IN_S * 1000) {
        logProgress()
        lastLog = Date.now()
      }
    },
    { _id: 1, totalTokens: 1 }
  )

  logProgress()
}

module.exports = main

if (require.main === module) {
  main(DRY_RUN)
    .then(() => {
      console.log('Done.')
      process.exit(0)
    })
    .catch(error => {
      console.error({ error })
      process.exit(1)
    })
}
