import { expect } from 'chai'

import {
  filterZoteroItems,
  itemHaystack,
  normalizeFilter,
} from '@/features/source-editor/aegeanexts/CrosRefSearch/zotero-filter'

/**
 * FIXED: 2026-11-17 回归：Zotero 搜索框改成「内存过滤」。
 *
 * 原来每敲一个字就向 api.zotero.org 发一次请求（limit 25），而且「搜索」按钮在
 * Zotero 档恒为禁用（判的是 title/author，那两个框在 Zotero 档不存在），
 * 结果用户只看得到「导入整库到 .bib」。现在一次拉 200 条在本地筛。
 */

const items = [
  {
    hash_id: 'A',
    title_text: ['ASP网络编程技术与实例'],
    authors: ['胡标'],
    year: '2004',
    container_title_text: ['人民邮电出版社'],
    abstract_text: '网络编程基础',
  },
  {
    hash_id: 'B',
    title_text: ['Deep Learning for Vision'],
    authors: ['LeCun, Yann', 'Bengio, Yoshua'],
    year: '2015',
    container_title_text: ['Nature'],
    abstract_text: 'convolutional networks',
  },
  {
    hash_id: 'C',
    title_text: ['参考文献管理工具比较'],
    authors: ['张三'],
    year: '2021',
    container_title_text: ['图书情报工作'],
    abstract_text: 'Zotero EndNote RefWorks',
  },
]

describe('normalizeFilter', () => {
  it('大小写、全角、空白都折平', () => {
    expect(normalizeFilter('  Deep   LEARNING ')).to.equal('deep learning')
    expect(normalizeFilter('ＺＯＴＥＲＯ')).to.equal('zotero')
    expect(normalizeFilter(null)).to.equal('')
  })
})

describe('itemHaystack', () => {
  it('覆盖结果表里展示的字段（含摘要）', () => {
    const text = itemHaystack(items[1])
    expect(text).to.include('deep learning')
    expect(text).to.include('lecun')
    expect(text).to.include('2015')
    expect(text).to.include('nature')
    expect(text).to.include('convolutional')
  })
})

describe('filterZoteroItems', () => {
  it('空查询不过滤，且返回同一个数组引用（避免无谓重渲染）', () => {
    expect(filterZoteroItems(items, '')).to.equal(items)
    expect(filterZoteroItems(items, '   ')).to.equal(items)
    expect(filterZoteroItems(undefined as any, 'x')).to.deep.equal([])
  })

  it('中文按子串匹配', () => {
    expect(filterZoteroItems(items, '网络').map(i => i.hash_id)).to.deep.equal([
      'A',
    ])
    expect(filterZoteroItems(items, '文献').map(i => i.hash_id)).to.deep.equal([
      'C',
    ])
  })

  it('英文大小写不敏感，作者与期刊都能命中', () => {
    expect(
      filterZoteroItems(items, 'deep learning').map(i => i.hash_id)
    ).to.deep.equal(['B'])
    expect(filterZoteroItems(items, 'lecun').map(i => i.hash_id)).to.deep.equal(
      ['B']
    )
    expect(
      filterZoteroItems(items, '图书情报').map(i => i.hash_id)
    ).to.deep.equal(['C'])
  })

  it('多个词是 AND 语义', () => {
    expect(filterZoteroItems(items, 'zotero 2021').map(i => i.hash_id)).to.deep.equal(
      ['C']
    )
    // 词分属不同条目时不该命中
    expect(filterZoteroItems(items, 'zotero 2004')).to.deep.equal([])
  })

  it('年份单独可筛（用户常按年份找）', () => {
    expect(filterZoteroItems(items, '2015').map(i => i.hash_id)).to.deep.equal([
      'B',
    ])
  })

  it('摘要里的词也能命中（元数据都在内存里，不额外请求）', () => {
    expect(
      filterZoteroItems(items, 'flylatex').map(i => i.hash_id)
    ).to.deep.equal(['C'])
  })
})
