const ImageService = require('./ImageService')

class ImageController {
  /**
   * 上传 base64 图片
   * POST /api/agent/images
   * Body: { base64: "data:image/png;base64,..." }
   * Response: { imageId: "xxx", url: "/api/agent/images/xxx" }
   */
  static async uploadImage(req, res, next) {
    try {
      const { base64 } = req.body

      if (!base64) {
        return res.status(400).json({ error: 'Missing base64 image data' })
      }

      const imageId = await ImageService.saveBase64Image(base64)
      
      res.status(200).json({
        imageId,
        url: `/api/agent/images/${imageId}`
      })
    } catch (error) {
      console.error('Image upload error:', error)
      res.status(500).json({ error: error.message || 'Failed to upload image' })
    }
  }

  /**
   * 获取图片（文件下载）
   * GET /api/agent/images/:imageId
   */
  static async getImage(req, res, next) {
    try {
      const { imageId } = req.params
      const imagePath = ImageService.getImagePath(imageId)

      if (!imagePath) {
        return res.status(404).json({ error: 'Image not found' })
      }

      // 直接发送文件
      res.sendFile(imagePath)
    } catch (error) {
      console.error('Image fetch error:', error)
      res.status(500).json({ error: error.message || 'Failed to fetch image' })
    }
  }

  /**
   * 获取图片 base64 数据（用于模型输入）
   * GET /api/agent/images/:imageId/base64
   * Response: { base64: "data:image/png;base64,..." }
   */
  static async getImageBase64(req, res, next) {
    try {
      const { imageId } = req.params
      const base64Data = await ImageService.getBase64Image(imageId)

      res.status(200).json({ base64: base64Data })
    } catch (error) {
      console.error('Image base64 fetch error:', error)
      res.status(404).json({ error: 'Image not found' })
    }
  }

  /**
   * 删除图片
   * DELETE /api/agent/images/:imageId
   */
  static async deleteImage(req, res, next) {
    try {
      const { imageId } = req.params
      await ImageService.deleteImage(imageId)

      res.status(200).json({ success: true })
    } catch (error) {
      console.error('Image delete error:', error)
      res.status(500).json({ error: error.message || 'Failed to delete image' })
    }
  }
}

module.exports = ImageController
