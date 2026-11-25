// FIXED: 2026-11-10 「帮助 → 关于系统」弹窗的品牌标记（第四版）
//
// 前三版都出了问题，这里把踩过的坑全部记下来，避免再犯：
//
//   1. 第一版：拿 public/mask-favicon.svg 的轮廓当 FlyLaTeX 的标志 ——
//      那其实是 Overleaf 的 "6" 字形，跟 FlyLaTeX 毫无关系。还在上面叠了
//      描边副本 + 闭合圆环光环，64px 小图上看不出问题，放大到 200px 才发现
//      字腔被糊成一团脏块。
//   2. 第二版：只把图形简化成纯渐变填充，没有质疑图形本身就是错的。
//   3. 第三版：改成复用加载页的 .loading-screen-brand，方向对了，但用 <span>
//      承载它 —— span 是 inline 元素，inline 元素会忽略 width / height /
//      padding-top 的垂直影响，容器算出 0x0，::before / ::after 的 inset:0
//      也就只能是零尺寸，结果字标完全不显示（浏览器里实测 rect 就是 0x0）。
//      加载页之所以正常，是因为它用的是 <div>（block）。
//
// 现在：FlyLaTeX 没有独立的图标形状，品牌标识就是系统加载页那个 FlyLaTeX 字标。
// 动画样式完全复用 app/editor.less 的 .loading-screen-brand，不在组件里重画：
//   - ::before 底图 ol-brand/overleaf-o-loading-base.svg（淡灰，始终在）
//   - ::after  前景 ol-brand/overleaf-o-gradient.svg（灰蓝渐变，clip-path 自下而上填充）
//   - 1.8s ease-in-out infinite + fl-brand-rise 关键帧
//   - prefers-reduced-motion 下自动降级为 fl-brand-pulse（只变透明度、不位移）
//
// 关键点：承载 .loading-screen-brand 的元素必须是块级（这里显式 display:block），
// 否则 padding-top 撑不开高度，字标不会显示。
//
// 注意：那两个 SVG 文件名沿用了 Overleaf 的命名（ol-brand / overleaf-o-*），
// 但内容早已被替换成 FlyLaTeX 字标，别被文件名误导。

type Props = {
  /** 字标宽度（px）。高度由 .loading-screen-brand 的 padding-top 按原图比例（220:60）推导 */
  width?: number
  className?: string
}

export default function AboutBrandMark({ width = 150, className }: Props) {
  return (
    // 外层只为定宽居中；内层承载 .loading-screen-brand。
    // 内层必须 display:block —— 用 span 的默认 inline 会让 padding-top 失效、高度为 0。
    <span
      className={['about-brand-mark-wrapper', className]
        .filter(Boolean)
        .join(' ')}
      style={{
        display: 'block',
        width: `${width}px`,
        margin: '0 auto 4px', // 底部只留 4px，版本号 <p> 自己还有外边距
      }}
    >
      <span
        className="loading-screen-brand"
        role="img"
        aria-label="FlyLaTeX"
        data-testid="about-brand-mark"
        style={{ display: 'block' }}
      />
    </span>
  )
}
