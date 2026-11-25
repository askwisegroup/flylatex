# commercial/ — 商业集成占位

社区版**不包含**任何商业系统实现。这个目录里的文件都是 `_stub.js` 生成的空壳：
加载期不报错、调用期返回 `undefined` 并打一条 warn，相关功能表现为「未启用」。

完整产品里这些能力由**独立部署的服务**通过 HTTP 提供（外部账号中心、
高校联合登录、私有 LLM 网关、个人知识库、文献检索等），不在开源范围内。

与它们无关、可以独立使用的部分被移到了各自目录：

* `../llm-providers/` —— OpenAI 兼容协议适配器（chat_completions / responses）
* `../google-auth/` —— Google ID Token 验签
