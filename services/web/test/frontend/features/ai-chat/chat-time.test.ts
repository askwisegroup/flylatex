import { expect } from 'chai'

import {
  computeElapsedByMessageId,
  formatElapsed,
  formatMessageTime,
} from '@/shared/utils/chat-time'

// FIXED: 2026-11-17 AI 面板时间戳格式规则的用例：
//   当天 → 24 进制到秒；同年非当天 → MM-DD HH:MM:SS；跨年 → YYYY-MM-DD HH:MM:SS；
//   手机端历史消息省掉秒（宽度不够时优先保住「几点」）。
describe('chat-time', function () {
  // 固定「现在」：2026-11-17 15:30:00 本地时间
  const now = new Date(2026, 10, 17, 15, 30, 0)

  function at(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
    s: number
  ) {
    return new Date(y, mo - 1, d, h, mi, s)
  }

  describe('formatMessageTime', function () {
    it('当天只显示时间，精确到秒', function () {
      const parts = formatMessageTime(at(2026, 11, 17, 14, 5, 9), { now })
      expect(parts).to.deep.equal({
        date: '',
        clock: '14:05:09',
        full: '14:05:09',
        iso: '2026-11-17T14:05:09',
      })
    })

    it('当天在手机端同样保留秒（需求里唯一强制的精度）', function () {
      const parts = formatMessageTime(at(2026, 11, 17, 9, 8, 7), {
        now,
        isMobile: true,
      })
      expect(parts).to.deep.equal({
        date: '',
        clock: '09:08:07',
        full: '09:08:07',
        iso: '2026-11-17T09:08:07',
      })
    })

    it('同年非当天：MM-DD + 时间', function () {
      const parts = formatMessageTime(at(2026, 11, 16, 23, 59, 58), { now })
      expect(parts).to.deep.equal({
        date: '11-16',
        clock: '23:59:58',
        full: '2026-11-16 23:59:58',
        iso: '2026-11-16T23:59:58',
      })
    })

    it('跨年：YYYY-MM-DD + 时间', function () {
      const parts = formatMessageTime(at(2025, 1, 2, 3, 4, 5), { now })
      expect(parts).to.deep.equal({
        date: '2025-01-02',
        clock: '03:04:05',
        full: '2025-01-02 03:04:05',
        iso: '2025-01-02T03:04:05',
      })
    })

    it('手机端历史消息省掉秒，但日期两种都保留（不丢「哪天」）', function () {
      const sameYear = formatMessageTime(at(2026, 11, 16, 23, 59, 58), {
        now,
        isMobile: true,
      })
      expect(sameYear).to.deep.equal({
        date: '11-16',
        clock: '23:59',
        full: '2026-11-16 23:59:58',
        iso: '2026-11-16T23:59:58',
      })

      const crossYear = formatMessageTime(at(2025, 1, 2, 3, 4, 5), {
        now,
        isMobile: true,
      })
      expect(crossYear?.date).to.equal('2025-01-02')
      expect(crossYear?.clock).to.equal('03:04')
    })

    it('时间用 24 进制（下午不加 12 小时进制前缀）', function () {
      expect(formatMessageTime(at(2026, 11, 17, 13, 0, 0), { now })?.clock).to.equal(
        '13:00:00'
      )
      expect(formatMessageTime(at(2026, 11, 17, 0, 0, 1), { now })?.clock).to.equal(
        '00:00:01'
      )
    })

    it('没有时间戳的老消息返回 null（整块不渲染）', function () {
      expect(formatMessageTime(undefined, { now })).to.equal(null)
      expect(formatMessageTime(null, { now })).to.equal(null)
      expect(formatMessageTime('', { now })).to.equal(null)
      expect(formatMessageTime('not-a-date', { now })).to.equal(null)
    })

    it('接受 ISO 字符串（服务端返回的就是这个）', function () {
      const iso = at(2026, 11, 17, 8, 9, 10).toISOString()
      expect(formatMessageTime(iso, { now })?.full).to.match(
        /^08:09:10$/
      )
    })
  })

  describe('formatElapsed', function () {
    it('毫秒 / 秒 / 分秒三种量级', function () {
      expect(formatElapsed(320)).to.equal('320ms')
      expect(formatElapsed(8420)).to.equal('8.4s')
      expect(formatElapsed(72000)).to.equal('1m12s')
    })

    it('非法值返回空串（不显示，而不是显示 NaN）', function () {
      expect(formatElapsed(Number.NaN)).to.equal('')
      expect(formatElapsed(-1)).to.equal('')
    })
  })

  describe('computeElapsedByMessageId', function () {
    it('回复耗时 = 本条 - 它前面那条提问', function () {
      const map = computeElapsedByMessageId([
        { id: 'u1', role: 'user', createdAt: at(2026, 11, 17, 10, 0, 0) },
        { id: 'a1', role: 'assistant', createdAt: at(2026, 11, 17, 10, 0, 8) },
        { id: 'u2', role: 'user', createdAt: at(2026, 11, 17, 10, 5, 0) },
        { id: 'a2', role: 'assistant', createdAt: at(2026, 11, 17, 10, 6, 30) },
      ] as any)
      expect(map).to.deep.equal({ a1: 8000, a2: 90000 })
    })

    it('中间夹着占位消息不影响配对', function () {
      const map = computeElapsedByMessageId([
        { id: 'u1', role: 'user', createdAt: at(2026, 11, 17, 10, 0, 0) },
        { id: 'sys', role: 'system', createdAt: null },
        { id: 'a1', role: 'assistant', createdAt: at(2026, 11, 17, 10, 0, 2) },
      ] as any)
      expect(map).to.deep.equal({ a1: 2000 })
    })

    it('缺时间戳（老消息）不给耗时，且不会串到下一轮', function () {
      const map = computeElapsedByMessageId([
        { id: 'u0', role: 'user', createdAt: null },
        { id: 'a0', role: 'assistant', createdAt: at(2026, 11, 17, 10, 0, 5) },
        { id: 'u1', role: 'user', createdAt: at(2026, 11, 17, 11, 0, 0) },
        { id: 'a1', role: 'assistant', createdAt: at(2026, 11, 17, 11, 0, 1) },
      ] as any)
      expect(map).to.deep.equal({ a1: 1000 })
    })
  })
})
