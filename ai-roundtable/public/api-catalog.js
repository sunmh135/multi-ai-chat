// Curated Chat Completions presets. Keep newer releases/updates first.
export const API_PRESETS = [
  {
    id: 'deepseek', name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-flash', date: '2026-09-10' },
      { id: 'deepseek-v4-pro', date: '2026-08-13' },
    ],
  },
  {
    id: 'qwen', name: '通义千问（阿里云百炼）',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    models: [
      { id: 'qwen3.8-max-0902' },
      { id: 'qwen3.8-flash' },
      { id: 'qwen3.8-max' },
      { id: 'qwen3.7-flash' },
      { id: 'qwen3.7-plus' },
    ],
  },
  {
    id: 'glm', name: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    models: [
      { id: 'glm-5.3-flash' },
      { id: 'glm-5.3' },
      { id: 'glm-5.2' },
    ],
  },
  {
    id: 'volcengine', name: '火山方舟（豆包）',
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    apiKeyUrl: 'https://console.volcengine.com/ark/apiKey',
    models: [
      { id: 'doubao-seed-2-1-lite-260915', label: 'Doubao-Seed-2.1-lite' },
    ],
  },
];
