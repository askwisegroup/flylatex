import App from '../../base'
import { rootContext } from '../../shared/context/root-context'
// import ChatPane from '../../features/chat/components/chat-pane'
// import AIChatPane from '../../features/chat/components/ai-pane'
import EmbeddedChatPane from '../../features/chat/components/emb-ai-panel'
import { react2angular } from 'react2angular'

// App.component('chat', react2angular(rootContext.use(ChatPane)))
// App.component('chat', react2angular(rootContext.use(AIChatPane)))
App.component('chat', react2angular(rootContext.use(EmbeddedChatPane)))
