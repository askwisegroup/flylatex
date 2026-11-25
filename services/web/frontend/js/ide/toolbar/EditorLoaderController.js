import App from '../../base'

App.controller('EditorLoaderController', [
  '$scope',
  'localStorage',
  function ($scope, localStorage) {
    $scope.$watch('editor.showVisual', function (val) {
      localStorage(
        `editor.mode.${$scope.project_id}`,
        val === true ? 'rich-text' : 'source'
      )
    })

    $scope.$watch('editor.newSourceEditor', function (val) {
      // FIXED: 2026-11-08 只有明确是布尔值时才落库。
      // OLD: val === true ? 'cm6' : 'ace'  → undefined 也会写成 'ace'，
      //   一旦某个时刻 scope 值还没就绪，就会把项目永久记成「用旧编辑器」，
      //   下次加载 EditorManager.newSourceEditor() 返回 false，
      //   编辑器开关就变成两个都不选中的诡异状态。
      if (val !== true && val !== false) {
        return
      }
      localStorage(
        `editor.source_editor.${$scope.project_id}`,
        val === true ? 'cm6' : 'ace'
      )
    })
  },
])
