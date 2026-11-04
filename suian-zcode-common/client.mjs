// 公共客户端入口（运行期契约，PKG-01）。只做再导出；导入本模块不启动服务、
// 不读取凭据、不扫描源码指纹。导出集合以三个业务消费者的实际使用为准。
export const COMMON_API_VERSION = 1;
export { connectHost, probeHost } from './gateway-client.mjs';
export { saveAuthorization, clearAuthorization } from './auth-store.mjs';
export { readTitlePolicy, writeTitlePolicy } from './title-policy.mjs';
export { readProjectContext } from './project-context.mjs';
export { MCP_APP_MIME_TYPE, supportsZcodeMcpApps } from './ui-capabilities.mjs';
export { notifyOnce } from './notifications.mjs';
export { checkPromptRecoveryToast } from './prompt-recovery.mjs';
export { shouldNotify } from './cooldown.mjs';
export { copyPromptAndOpenWorkspace } from './notification-action.mjs';
export { getConversationMessageProjectionPolicy } from './vendor/projection.js';
export {
  TopicWireFrameAssembler, conversationTopicFrameSchema, v4ConversationRowsRangeResultSchema,
  PROTOCOL_V4_LIMITS, measureTopicNotificationEnvelopeBytes, encodeTopicWireFrames,
} from './vendor/conversation-wire.js';
