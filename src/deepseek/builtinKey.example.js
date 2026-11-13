/**
 * 内置免费接口的 Key —— 仓库里的占位模板。
 *
 * 复制成 builtinKey.js 后填入自己的 Key：
 *
 *     cp src/deepseek/builtinKey.example.js src/deepseek/builtinKey.js
 *
 * （`npm install` 会自动做这一步，正常情况下不用手动执行）
 *
 * 不填也能跑：应用会停在「内置接口未配置」状态，
 * 到设置里切到 DeepSeek 官方接口、填自己的 Key 即可正常使用。
 *
 * 想接入别的 OpenAI 兼容服务，把 BUILTIN_BASE_URL 也改掉即可，
 * 例如 https://api.siliconflow.cn/v1、https://open.bigmodel.cn/api/paas/v4。
 */
export const BUILTIN_KEY = ""

/** 内置接口的 OpenAI 兼容端点，留空则用默认的阿里云百炼 */
export const BUILTIN_BASE_URL = ""
