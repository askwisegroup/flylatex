/**
 * Simple toast notification utility
 * Shows a temporary message in the top-right corner
 */

interface ToastOptions {
  duration?: number
  position?: 'top-right' | 'top-center' | 'bottom-right' | 'bottom-center'
  /**
   * FIXED: 2026-10-27 只“转淡”关闭，不做滑出。用于那种不打扰输入、
   * 看一眼就好的轻提示（例如“AI 助手已更新此文件”）。
   */
  fadeOut?: boolean
}

const defaultOptions: ToastOptions = {
  duration: 3000,
  position: 'top-right',
}

export function showToast(message: string, options: ToastOptions = {}): void {
  const config = { ...defaultOptions, ...options }
  
  // Create container if it doesn't exist
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
      pointer-events: none;
    `
    document.body.appendChild(container)
  }

  // Create toast element
  const toast = document.createElement('div')
  toast.style.cssText = `
    background-color: #333;
    color: #fff;
    padding: 12px 16px;
    border-radius: 4px;
    margin-bottom: 10px;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
    animation: slideIn 0.3s ease-out;
  `
  
  toast.textContent = message
  
  // Add animation styles if not already present
  if (!document.getElementById('toast-styles')) {
    const styleSheet = document.createElement('style')
    styleSheet.id = 'toast-styles'
    styleSheet.textContent = `
      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes slideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(100%);
          opacity: 0;
        }
      }
      @keyframes fadeOut {
        from {
          opacity: 1;
        }
        to {
          opacity: 0;
        }
      }
    `
    document.head.appendChild(styleSheet)
  }

  container.appendChild(toast)

  // Auto remove after duration
  if (config.duration && config.duration > 0) {
    setTimeout(() => {
      // FIXED: 2026-10-27 fadeOut 选项：纯透明度渐隐，不移位
      const exit = config.fadeOut
        ? { animation: 'fadeOut 0.4s ease-out', delay: 400 }
        : { animation: 'slideOut 0.3s ease-out', delay: 300 }
      toast.style.animation = exit.animation
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast)
        }
      }, exit.delay)
    }, config.duration)
  }
}

export function showSuccessToast(message: string, duration = 3000): void {
  const container = document.getElementById('toast-container')
  if (container) {
    // Custom style for success toast
    const lastChild = container.lastElementChild as HTMLElement
    if (lastChild) {
      // Update previous toast to success style if needed
    }
  }
  showToast(message, { duration })
}

export function showErrorToast(message: string, duration = 5000): void {
  showToast(message, { duration })
}
