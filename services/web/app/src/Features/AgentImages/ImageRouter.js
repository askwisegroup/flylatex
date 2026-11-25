const ImageController = require('./ImageController')

module.exports = {
  apply(webRouter) {
    webRouter.post('/api/agent/images', ImageController.uploadImage)
    webRouter.get('/api/agent/images/:imageId', ImageController.getImage)
    webRouter.get('/api/agent/images/:imageId/base64', ImageController.getImageBase64)
    webRouter.delete('/api/agent/images/:imageId', ImageController.deleteImage)
  }
}
