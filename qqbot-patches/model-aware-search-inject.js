/* >>> dsh-qqbot-patch:model-aware-search-inject >>> */
// 联网工具和提示词注册显式等待服务就绪，不依赖插件加载时序。
export const inject = ['agents', 'web', 'tools', 'systemPrompt'];
/* <<< dsh-qqbot-patch:model-aware-search-inject <<< */
