'use strict'

angular
  .module('aiChatPanel', [])
  .controller('AIChatController', AIChatController)

  .factory('$scope', function ($scope, $http, $window) {
    return {
      chatMessages: [],
      isSending: false,

      sendMessage: function (message) {
        this.isSending = true
        this.chatMessages.push({
          user: message,
          timestamp: new Date().toISOString(),
          role: 'user',
        })

        // 调用 AI Agent 服务
        $http
          .post('/project/' + $scope.project_id + '/ai-chat', {
            content: message,
          })
          .then(response => {
            this.chatMessages.push({
              content: response.data || response.msg || '抱歉，服务暂时不可用',
              timestamp: new Date().toISOString(),
              role: 'assistant',
            })
            this.isSending = false
          })
      },

      clearChat: function () {
        this.chatMessages = []
      },
    }
  })
