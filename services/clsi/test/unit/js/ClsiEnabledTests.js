const { expect } = require('chai')
const { isEnabled } = require('../../../app/js/ClsiEnabled')

// 拆分部署（web 容器 + clsi 容器）靠这个开关让 web 容器里的 clsi 不生效。
// 默认必须与现在完全一致，否则「一键切回单容器」就不成立了。
describe('ClsiEnabled', function () {
  it('is enabled by default', function () {
    expect(isEnabled({}, {})).to.equal(true)
    expect(isEnabled(undefined, undefined)).to.equal(true)
  })

  it('can be disabled by CLSI_ENABLED=false', function () {
    expect(isEnabled({ CLSI_ENABLED: 'false' }, {})).to.equal(false)
    expect(isEnabled({ CLSI_ENABLED: 'FALSE' }, {})).to.equal(false)
    expect(isEnabled({ CLSI_ENABLED: '0' }, {})).to.equal(false)
  })

  it('can be disabled by Settings.clsi.enabled=false', function () {
    expect(isEnabled({}, { clsi: { enabled: false } })).to.equal(false)
  })

  it('stays enabled for anything else (e.g. a truthy-looking typo)', function () {
    expect(isEnabled({ CLSI_ENABLED: 'true' }, {})).to.equal(true)
    expect(isEnabled({ CLSI_ENABLED: '' }, {})).to.equal(true)
    expect(isEnabled({}, { clsi: {} })).to.equal(true)
  })
})
