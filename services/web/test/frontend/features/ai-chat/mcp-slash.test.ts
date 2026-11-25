import { expect } from 'chai'

import {
  getSlashQuery,
  filterMcpServers,
  removeSlashToken,
  MAX_MCP_CANDIDATES,
} from '@/features/ai-chat/utils/mcp-slash'

describe('ai-chat mcp-slash', function () {
  describe('getSlashQuery', function () {
    it('行首/空白后的 / 触发', function () {
      expect(getSlashQuery('/', 1)).to.deep.equal({ start: 0, query: '' })
      expect(getSlashQuery('用 /kb', 5)).to.deep.equal({
        start: 2,
        query: 'kb',
      })
    })

    it('路径、URL、\\input 里的 / 不触发', function () {
      expect(getSlashQuery('chapters/main.tex', 17)).to.equal(null)
      expect(getSlashQuery('http://example.com/x', 20)).to.equal(null)
      expect(getSlashQuery('\\input{a/b}', 11)).to.equal(null)
      expect(getSlashQuery('a / b', 5)).to.equal(null)
    })

    it('查询词过长时放弃', function () {
      const long = '/' + 'a'.repeat(120)
      expect(getSlashQuery(long, long.length)).to.equal(null)
    })

    it('光标不在 / 词里返回 null', function () {
      expect(getSlashQuery('/kb 后面的字', 10)).to.equal(null)
      expect(getSlashQuery('', 0)).to.equal(null)
    })
  })

  describe('filterMcpServers', function () {
    const servers = [
      { id: 's1', name: 'kb' },
      { id: 's2', name: 'kb-company' },
      { id: 's3', name: 'git' },
      { id: 's4', name: '公司知识库' },
    ]

    it('前缀优先、其次包含', function () {
      expect(filterMcpServers(servers, 'kb').map(s => s.name)).to.deep.equal([
        'kb',
        'kb-company',
      ])
      expect(filterMcpServers(servers, 'com').map(s => s.name)).to.deep.equal([
        'kb-company',
      ])
    })

    it('大小写不敏感 + 中文', function () {
      expect(filterMcpServers(servers, 'KB').length).to.equal(2)
      expect(filterMcpServers(servers, '知识').map(s => s.name)).to.deep.equal([
        '公司知识库',
      ])
    })

    it('空查询按顺序截断', function () {
      expect(filterMcpServers(servers, '').length).to.equal(4)
      expect(filterMcpServers(servers, '', 2).length).to.equal(2)
      expect(filterMcpServers(servers, '').length).to.be.at.most(
        MAX_MCP_CANDIDATES
      )
    })

    it('没有匹配返回空数组', function () {
      expect(filterMcpServers(servers, 'nope')).to.deep.equal([])
    })
  })

  describe('removeSlashToken', function () {
    it('去掉 /服务名 并收掉多余空格', function () {
      expect(removeSlashToken('/kb 帮我看下', 'kb')).to.equal('帮我看下')
      expect(removeSlashToken('看下 /kb  这个', 'kb')).to.equal('看下 这个')
    })

    it('没出现时不改动文本', function () {
      expect(removeSlashToken('没有服务', 'kb')).to.equal('没有服务')
    })
  })
})
