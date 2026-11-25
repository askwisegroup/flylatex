import React, { useState } from 'react'
import ChatPane from './chat-pane'

const EmbeddedChatPane = () => {
  const [toggleAI, setToggleAI] = useState(false);

  // 2026-02-21： 停用之前的 FastGPT 的服务，采用自己开发的 Tiny Agent 进行服务
  return (
    <div className="w-full h-full">
      {/* <div className="toolbar" style={{ backgroundColor: '#2c3645', height: '30px', fontSize: '13px', fontWeight: 'bold' }}>
        <button onClick={() => setToggleAI(!toggleAI)} className="toggle-ai-button btn-primary" style={{ color: '#FFF', zIndex: 1000 }}>
          {toggleAI ? 'Show Chat' : 'Show AI'}
        </button>
      </div> */}
      <div>
        {toggleAI ?
        (<iframe
          src="https://www.example.com/ai/chat/share?shareId=wv7ajohmieehmra1tannsasu"
          style={{ width: '100%', height: 'calc(100vh - 70px)' }}
          frameBorder="0"
          allow="*"
        />
        ): (
          <ChatPane />
        )}
      </div>
    </div>
  )
}

export default EmbeddedChatPane;
