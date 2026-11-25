import { captureMessage } from './infrastructure/error-reporter'

if (window.ExposedSettings.isOverleaf) {
  const cdnLoadTest = document.createElement('img')
  cdnLoadTest.addEventListener('error', function () {
    captureMessage('CDN test 2 image load error (same-origin)')
  })
  cdnLoadTest.src = '/img/1p.gif'

  const cdnLoadTestOld = document.createElement('img')
  cdnLoadTestOld.addEventListener('error', function () {
    captureMessage('CDN test 2 image load error (same-origin, legacy path)')
  })
  cdnLoadTestOld.src = '/img/1p.gif'
}
