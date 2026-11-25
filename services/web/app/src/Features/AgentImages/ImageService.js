const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// 使用标准持久化目录，由 docker-compose volume 挂载
const AGENT_IMAGES_DIR = '/var/lib/sharelatex/agent-images'

// 懒加载方式确保目录存在
function ensureDir() {
  if (!fs.existsSync(AGENT_IMAGES_DIR)) {
    try {
      fs.mkdirSync(AGENT_IMAGES_DIR, { recursive: true })
    } catch (err) {
      console.error('Failed to create agent-images directory:', err)
    }
  }
}

class ImageService {
  /**
   * 保存 base64 图片并返回 ID
   * @param {string} base64Data - base64 格式的图片数据 (data:image/png;base64,xxxx)
   * @returns {Promise<string>} 图片 ID
   */
  static async saveBase64Image(base64Data) {
    try {
      // 确保目录存在
      ensureDir()
      
      // 提取 base64 数据部分
      const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/)
      if (!matches) {
        throw new Error('Invalid base64 image format')
      }

      const [, ext, imageData] = matches
      const buffer = Buffer.from(imageData, 'base64')
      
      // 生成唯一 ID
      const imageId = crypto.randomBytes(12).toString('hex')
      const filename = `${imageId}.${ext}`
      const filepath = path.join(AGENT_IMAGES_DIR, filename)

      // 保存文件
      fs.writeFileSync(filepath, buffer)
      
      return imageId
    } catch (error) {
      console.error('Error saving image:', error)
      throw error
    }
  }

  /**
   * 根据 ID 获取图片的 base64 数据
   * @param {string} imageId - 图片 ID
   * @returns {Promise<string>} base64 格式的图片数据
   */
  static async getBase64Image(imageId) {
    try {
      // 找到对应的文件
      const files = fs.readdirSync(AGENT_IMAGES_DIR)
      const matchedFile = files.find(f => f.startsWith(imageId))
      
      if (!matchedFile) {
        throw new Error(`Image not found: ${imageId}`)
      }

      const filepath = path.join(AGENT_IMAGES_DIR, matchedFile)
      const buffer = fs.readFileSync(filepath)
      const ext = path.extname(matchedFile).slice(1)
      
      return `data:image/${ext};base64,${buffer.toString('base64')}`
    } catch (error) {
      console.error('Error getting image:', error)
      throw error
    }
  }

  /**
   * 删除图片
   * @param {string} imageId - 图片 ID
   */
  static async deleteImage(imageId) {
    try {
      const files = fs.readdirSync(AGENT_IMAGES_DIR)
      const matchedFile = files.find(f => f.startsWith(imageId))
      
      if (matchedFile) {
        const filepath = path.join(AGENT_IMAGES_DIR, matchedFile)
        fs.unlinkSync(filepath)
      }
    } catch (error) {
      console.error('Error deleting image:', error)
      throw error
    }
  }

  /**
   * 获取图片的文件路径（用于响应）
   * @param {string} imageId - 图片 ID
   * @returns {string|null} 文件路径
   */
  static getImagePath(imageId) {
    try {
      const files = fs.readdirSync(AGENT_IMAGES_DIR)
      const matchedFile = files.find(f => f.startsWith(imageId))
      
      if (!matchedFile) {
        return null
      }

      return path.join(AGENT_IMAGES_DIR, matchedFile)
    } catch (error) {
      return null
    }
  }
}

module.exports = ImageService
