import { expect } from 'chai'
import {
  IME_ENTER_GRACE_MS,
  isImeComposing,
} from '../../../../frontend/js/shared/utils/ime'

function keyEvent(nativeEvent: { isComposing?: boolean; keyCode?: number }) {
  return { nativeEvent }
}

describe('isImeComposing', function () {
  it('组合输入进行中（isComposing）时返回 true', function () {
    expect(isImeComposing(keyEvent({ isComposing: true, keyCode: 13 }))).to.be
      .true
  })

  it('按键已交由输入法处理（keyCode 229）时返回 true', function () {
    expect(isImeComposing(keyEvent({ isComposing: false, keyCode: 229 }))).to.be
      .true
  })

  it('普通 Enter（裸输入）返回 false', function () {
    expect(isImeComposing(keyEvent({ isComposing: false, keyCode: 13 }))).to.be
      .false
  })

  it('缺少组合输入标记时返回 false', function () {
    expect(isImeComposing(keyEvent({}))).to.be.false
  })

  it(`${IME_ENTER_GRACE_MS}ms 宽限窗口内（刚 compositionend）返回 true`, function () {
    const endedAt = 1_000_000
    expect(
      isImeComposing(
        keyEvent({ isComposing: false, keyCode: 13 }),
        endedAt,
        endedAt + IME_ENTER_GRACE_MS - 1
      )
    ).to.be.true
  })

  it('宽限窗口结束后返回 false', function () {
    const endedAt = 1_000_000
    expect(
      isImeComposing(
        keyEvent({ isComposing: false, keyCode: 13 }),
        endedAt,
        endedAt + IME_ENTER_GRACE_MS
      )
    ).to.be.false
  })
})
