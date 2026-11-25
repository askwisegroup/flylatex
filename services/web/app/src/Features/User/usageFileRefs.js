/**
 * 从 project.rootFolder 里收集所有 fileRefs。
 *
 * Project 模型里 `rootFolder: [FolderSchema]` 是**数组**（见 models/Project.js），
 * 而 FolderSchema 自己是对象。之前这里（以及它替换掉的旧实现
 * `processFolder(project.rootFolder)`）都直接读 `.fileRefs`：
 * 对数组读出 undefined，于是 33 个项目、几百个文档的情况下附件永远是
 * `0 B · 0 个`，而页面上其余数字都正常。
 *
 * 所以这里两种形状都要接受：数组（根）与对象（子目录）。
 */
function collectFileRefs(rootFolder) {
  const files = []
  const walk = node => {
    if (!node) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (Array.isArray(node.fileRefs)) {
      for (const file of node.fileRefs) {
        if (file && file._id) files.push(file)
      }
    }
    if (Array.isArray(node.folders)) node.folders.forEach(walk)
  }
  walk(rootFolder)
  return files
}

module.exports = { collectFileRefs }
