/**
 * 对话 API 客户端。
 *
 * 两种模式，设置页一键切换：
 *  - 内置免费（默认）：阿里云百炼 OpenAI 兼容接口，Key 内置在包内，
 *    装好就能问，不需要用户填任何东西；模型列表走 GET /models 动态获取
 *    （DeepSeek / 通义 / Kimi / GLM 等）；
 *  - DeepSeek 官方：OpenAI 兼容接口，用用户自己的 Key，
 *    额外支持 /v1/tools/search 联网搜索与 /user/balance 余额查询。
 *
 * 两边的返回值统一成 { content, reasoning, usage, model }，
 * 页面不需要关心底下说的是什么方言。
 */

import { fetch } from "../tsimports"
import logger from "../logger/logger"
import { sleep, withTimeout } from "../lib/async"
import { getApiKey as readStoredKey } from "../lib/apiKeyStore"
import { parseSearchDecision } from "../lib/searchIntent"
import { BUILTIN_KEY, BUILTIN_BASE_URL } from "./builtinKey"

const NETWORK_ERROR_CODE = 300
// 思考模式下推理内容与正文共用输出预算。官方默认给到 64K，
// 手表端按 12000 控制成本与等待时间，避免长推理把正文挤成空串。
const THINKING_MAX_TOKENS = 12000
// 正文被推理挤空后，用非思考模式补一次简短结论
const EMPTY_ANSWER_RETRY_TOKENS = 1200
const ANTHROPIC_VERSION = "2023-06-01"
// 联网搜索每次固定取 10 条。接口默认值也是 10，这里显式写死：
// 条数一变，资料覆盖面就跟着变，同一类问题有时答得全、有时只看到一两条。
// 文档：count 取值 1~50，按请求次数计费，条数不影响价格。
const SEARCH_COUNT = 10
// 低分重搜的判定线。文档里 rerank_score 1.5 以上算优质，这里要求至少有 2 条
// 优质结果，且最高分不低于 1.2；达不到就换一种说法再搜一次（只重搜一次）。
const SEARCH_GOOD_SCORE = 1.5
const SEARCH_GOOD_MIN = 2
// 重搜的超时比首次短：第一次已经等了 50 秒，第二次再等一整轮就没意义了
const SEARCH_RETRY_TIMEOUT = 35000

/**
 * 内置免费接口。
 * 用的是阿里云百炼的 OpenAI 兼容端点，支持 GET /models 列模型，
 * DeepSeek 系（v4.1-flash / v4-pro）和通义、Kimi、GLM 都在同一把 Key 下。
 *
 * Key 来自 ./builtinKey.js —— 那个文件被 .gitignore 忽略，不进仓库。
 * 构建时会随代码打进包里，任何人解包都能看到，只适合自用或小范围分发。
 * 没有配置 Key 时本模式不可用，界面会引导切到 DeepSeek 官方接口。
 */
const BUILTIN = {
    id: "builtin",
    name: "内置免费",
    appName: "AI 助手",
    baseUrl: BUILTIN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    key: BUILTIN_KEY,
    model: "deepseek-v4.1-flash",
    // 拉不到 /models 时的兜底，保证换网络环境也能聊
    models: ["deepseek-v4.1-flash", "deepseek-v4-pro", "qwen3.8-flash", "qwen-plus"],
    protocol: "openai",
    search: false,
    balance: false
}

const DEEPSEEK = {
    id: "deepseek",
    name: "DeepSeek",
    appName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    key: "",
    model: "deepseek-flash",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    protocol: "openai",
    search: true,
    balance: true
}

export class DeepSeekError extends Error {
    constructor(message, code, status) {
        super(message)
        this.name = "DeepSeekError"
        this.code = typeof code === "number" ? code : NETWORK_ERROR_CODE
        this.status = status || 0
    }
}

function isObj(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseIfString(value) {
    if (typeof value !== "string") return value
    try {
        return JSON.parse(value)
    } catch (e) {
        return value
    }
}

function configValue(selector, fallback) {
    try {
        const config = global.config
        if (!config || typeof config.read !== "function") return fallback
        const value = config.read(selector)
        return value === undefined || value === null ? fallback : value
    } catch (e) {
        return fallback
    }
}

/** 当前模式：builtin（内置免费） / deepseek（自己的 Key） */
export function getApiMode() {
    return configValue(c => c.apiMode, "builtin") === "deepseek" ? "deepseek" : "builtin"
}

/** 当前接口信息：名称、地址、协议、能力开关 */
export function getProviderInfo() {
    const base = getApiMode() === "deepseek" ? DEEPSEEK : BUILTIN
    return {
        id: base.id,
        name: base.name,
        appName: base.appName,
        baseUrl: base.baseUrl,
        protocol: base.protocol,
        model: base.model,
        models: base.models.slice(),
        search: base.search,
        balance: base.balance
    }
}

/** 内置模式直接用包里的 Key；DeepSeek 用用户自己填的那份 */
export function getApiKey() {
    if (getApiMode() === "builtin") return BUILTIN.key
    const stored = readStoredKey()
    if (stored) return stored
    return String(configValue(c => c.deepseekApiKey, "") || "").trim()
}

export function hasApiKey() {
    return !!getApiKey()
}

/** 内置接口是否配了 Key。开源版默认是空串，需要自己填 builtinKey.js */
export function isBuiltinConfigured() {
    return !!String(BUILTIN_KEY || "").trim()
}

export function getModel() {
    if (getApiMode() === "builtin") {
        return String(configValue(c => c.builtinModel, "") || "").trim() || BUILTIN.model
    }
    return String(configValue(c => c.deepseekModel, "") || "").trim() || DEEPSEEK.model
}

/**
 * GET /models，返回原始 id 数组。
 * 百炼与 DeepSeek 官方都实现了这个接口，只是条数差很多；
 * 过滤与排序交给 lib/modelCatalog.js。
 */
export async function listModels() {
    const data = await request("/models", { method: "GET", timeout: 20000, retries: 1 })
    let rows = []
    if (Array.isArray(data)) rows = data
    else if (isObj(data) && Array.isArray(data.data)) rows = data.data
    else if (isObj(data) && Array.isArray(data.models)) rows = data.models

    const ids = []
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const id = typeof row === "string" ? row : (row && (row.id || row.name))
        if (id) ids.push(String(id))
    }
    return ids
}

export function isSearchEnabled() {
    return !!configValue(c => c.deepseekSearch, true)
}

/** 联网搜索只有 DeepSeek 官方接口支持 */
export function isSearchSupported() {
    return getProviderInfo().search
}

/** 余额查询只有 DeepSeek 官方接口支持 */
export function isBalanceSupported() {
    return getProviderInfo().balance
}

export function isThinkingEnabled() {
    // 两种模式都支持：DeepSeek 官方用 thinking，内置（百炼）用 enable_thinking
    return !!configValue(c => c.deepseekThinking, false)
}

function getMaxTokens() {
    const value = Number(configValue(c => c.deepseekMaxTokens, 1200))
    return value > 0 ? value : 1200
}

function createError(message, code, status) {
    return new DeepSeekError(message, code, status)
}

/**
 * 归一 fetch 的返回：目标固件可能返回 {data: 响应体} 或 {data: {data: 响应体}}，
 * 这里逐层剥壳，直到拿到真正的业务 JSON。
 */
function normalizeBody(raw) {
    if (raw === null || raw === undefined) return raw
    let body = (isObj(raw) && raw.data !== undefined) ? raw.data : raw
    body = parseIfString(body)
    if (isObj(body) && body.data !== undefined && !Array.isArray(body.data) &&
        body.error === undefined &&
        body.choices === undefined &&
        body.content === undefined &&
        body.results === undefined &&
        body.balance_infos === undefined &&
        body.is_available === undefined) {
        body = parseIfString(body.data)
    }
    return body
}

/** fetch 外壳里可能带 HTTP 状态码（不同固件字段位置不同） */
function extractHttpCode(raw) {
    if (isObj(raw) && typeof raw.code === "number") return raw.code
    if (isObj(raw) && isObj(raw.data) && typeof raw.data.code === "number") return raw.data.code
    return 0
}

function mapHttpMessage(status, body, provider) {
    const name = (provider && provider.name) || "服务端"
    const builtin = provider && provider.id === "builtin"
    const error = body && body.error
    const detail = (error && error.message) || (body && body.message) || ""
    if (status === 400 && /model/i.test(detail)) {
        return builtin ? "内置接口的模型暂不可用，请在设置里换一个模型" : "模型名无效，请在设置里重新选择"
    }
    if (status === 401) {
        return builtin ? "内置接口认证失败，请在设置里切换到 DeepSeek" : "API Key 无效或未授权"
    }
    if (status === 402) {
        return builtin ? "内置接口额度已用完，请在设置里切换到 DeepSeek" : "账户余额不足"
    }
    if (status === 403) {
        return builtin ? "内置接口拒绝访问，请在设置里切换到 DeepSeek" : (detail || "没有访问权限，请检查 Key")
    }
    if (status === 404) {
        return builtin ? "内置接口地址不可用，请在设置里切换到 DeepSeek" : "接口地址不存在"
    }
    if (status === 429) return "请求过于频繁，请稍后重试"
    if (status >= 500) return builtin ? "内置接口服务异常，请稍后再试" : `${name} 服务异常(${status})`
    return detail || `请求失败(${status})`
}

function apiError(status, body, provider) {
    return createError(mapHttpMessage(status, body, provider), status || 400, status)
}

/** 统一把 fetch 的失败对象转成带 status 的业务异常 */
function toClientError(e, provider) {
    if (e instanceof DeepSeekError) return e
    const code = e && typeof e.code === "number" ? e.code : 0
    if (code >= 400 && code < 600) {
        return createError(mapHttpMessage(code, e, provider), code, code)
    }
    const message = (e && (e.message || e.msg)) || "网络请求失败"
    // withTimeout 抛出的英文超时文案统一成可读中文
    const friendly = /timeout|超时/i.test(message) ? "请求超时，请检查网络后重试" : message
    return createError(friendly, NETWORK_ERROR_CODE)
}

function isRetryable(error) {
    if (!error) return false
    if (error.code === NETWORK_ERROR_CODE) return true
    return error.status === 429 || error.status >= 500
}

/** 指数退避：600ms / 1.2s / 2.4s，上限 4s，避免弱网下同时重试 */
function retryDelay(attempt) {
    return Math.min(4000, 600 * Math.pow(2, attempt))
}

/** Anthropic 只认 user / assistant，system 要单独提出来，且首条必须是 user */
function toAnthropicBody(model, messages, tokens) {
    const systems = []
    const list = []
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] || {}
        const content = String(msg.content || "")
        if (!content) continue
        if (msg.role === "system") {
            systems.push(content)
            continue
        }
        const role = msg.role === "assistant" ? "assistant" : "user"
        const last = list[list.length - 1]
        // 连续同角色的消息要并成一条，否则接口报 400
        if (last && last.role === role) last.content += "\n\n" + content
        else list.push({ role, content })
    }
    while (list.length && list[0].role !== "user") list.shift()
    const body = { model, max_tokens: tokens, messages: list, stream: false }
    if (systems.length) body.system = systems.join("\n\n")
    return body
}

function authHeader(provider, key) {
    if (provider.protocol === "anthropic") {
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION
        }
    }
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${key}`
    }
}

/** 按当前协议生成请求路径与请求体 */
function buildChatRequest(model, messages, tokens, thinking) {
    const provider = getProviderInfo()
    if (provider.protocol === "anthropic") {
        return { path: "/v1/messages", body: toAnthropicBody(model, messages, tokens) }
    }
    const body = {
        model,
        messages,
        stream: false,
        max_tokens: tokens
    }
    // thinking 是 DeepSeek 专有字段
    if (provider.id === "deepseek") {
        body.thinking = { type: thinking ? "enabled" : "disabled" }
    } else {
        // 百炼兼容端点：qwen3 / deepseek 系列默认开思考，
        // 不显式关掉会在首字前白等一两秒，还会把输出预算吃进推理里
        body.enable_thinking = !!thinking
    }
    return { path: "/chat/completions", body }
}

async function request(path, options) {
    options = options || {}

    const provider = getProviderInfo()
    const key = getApiKey()
    if (!key) {
        throw createError("请先在设置里填写 API Key", 401, 401)
    }

    const method = options.method || "POST"
    const timeout = options.timeout || 30000
    const retries = options.retries === undefined ? 1 : options.retries
    const url = provider.baseUrl + path

    const doFetch = () => fetch.fetch({
        url,
        method,
        data: options.body ? JSON.stringify(options.body) : undefined,
        responseType: "json",
        header: authHeader(provider, key)
    })

    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const raw = await withTimeout(doFetch(), timeout, "请求超时")
            const status = extractHttpCode(raw)
            const body = normalizeBody(raw)

            if (status >= 400) throw apiError(status, body, provider)
            if (isObj(body) && body.error) throw apiError(status || 400, body, provider)
            if (isObj(body) && body.type === "error") throw apiError(status || 400, body, provider)
            return body
        } catch (e) {
            lastError = toClientError(e, provider)
            if (attempt < retries && isRetryable(lastError)) {
                await sleep(retryDelay(attempt))
                continue
            }
            break
        }
    }

    logger.error(`[ai] ${path} 失败: ${lastError && lastError.message}`)
    throw lastError
}

/**
 * 从响应里取出正文、推理与用量。
 * OpenAI 方言看 choices[0].message，Anthropic 方言看 content[] 里的 text 块。
 */
function readAnswer(data) {
    if (data && Array.isArray(data.content)) {
        let text = ""
        for (let i = 0; i < data.content.length; i++) {
            const block = data.content[i]
            if (block && block.type === "text" && block.text) text += block.text
        }
        const usage = data.usage ? {
            prompt_tokens: Number(data.usage.input_tokens) || 0,
            completion_tokens: Number(data.usage.output_tokens) || 0,
            total_tokens: (Number(data.usage.input_tokens) || 0) + (Number(data.usage.output_tokens) || 0)
        } : null
        return {
            content: text.trim(),
            raw: text,
            reasoning: "",
            usage,
            model: data.model || "",
            finish: data.stop_reason === "max_tokens" ? "length" : "stop"
        }
    }

    const choice = data && data.choices && data.choices[0]
    const message = choice && choice.message ? choice.message : {}
    return {
        content: String(message.content || "").trim(),
        raw: String(message.content || ""),
        reasoning: String(message.reasoning_content || ""),
        usage: (data && (data.usage || data.token_usage || data.usage_metadata)) || null,
        model: (data && data.model) || "",
        finish: String((choice && choice.finish_reason) || "")
    }
}

/** 对话：返回 { content, reasoning, usage, model } */
export async function chat(messages, options) {
    options = options || {}
    const model = options.model || getModel()
    const thinking = options.thinking === undefined ? isThinkingEnabled() : !!options.thinking
    const maxTokens = options.maxTokens || (thinking ? THINKING_MAX_TOKENS : getMaxTokens())

    const send = (list, useThinking, tokens, timeout) => {
        const req = buildChatRequest(model, list, tokens, useThinking)
        return request(req.path, { body: req.body, timeout, retries: 0 })
    }

    // 思考模式生成慢，给更长的等待时间
    const data = await send(messages, thinking, maxTokens, thinking ? 150000 : 90000)
    const answer = readAnswer(data)
    if (answer.content) {
        return {
            content: answer.content,
            reasoning: answer.reasoning,
            usage: answer.usage,
            model: answer.model || model
        }
    }

    // 正文为空但存在推理：通常是推理把 max_tokens 吃满。
    // 关掉思考补问一次最终结论，避免让用户白等一场还只拿到报错。
    if (answer.reasoning) {
        logger.warn("[ai] 正文为空且存在推理，降级为非思考模式补问")
        try {
            const retryData = await send(
                messages.concat([{
                    role: "user",
                    content: "请直接给出最终答案，不要复述推理过程，控制在 200 字以内。"
                }]),
                false,
                EMPTY_ANSWER_RETRY_TOKENS,
                60000
            )
            const retryAnswer = readAnswer(retryData)
            if (retryAnswer.content) {
                return {
                    content: retryAnswer.content,
                    reasoning: answer.reasoning,
                    usage: retryAnswer.usage || answer.usage,
                    model: retryAnswer.model || model
                }
            }
        } catch (e) {
            logger.warn(`[ai] 补问失败: ${e && e.message}`)
        }
        throw createError("这次推理太长，没能生成正文，请重新提问或关闭深度思考", 502, 502)
    }

    throw createError("模型返回了空内容，请重试", 502, 502)
}

/** 累加多段请求的 usage，兼容不同固件的字段命名 */
function mergeUsage(total, usage) {
    if (!usage) return total || null
    const pick = (o, keys) => {
        for (let i = 0; i < keys.length; i++) {
            const v = o[keys[i]]
            if (typeof v === "number") return v
        }
        return 0
    }
    const add = (a, b) => (a || 0) + (b || 0)
    const base = total || {}
    return {
        prompt_tokens: add(pick(base, ["prompt_tokens"]), pick(usage, ["prompt_tokens"])),
        completion_tokens: add(pick(base, ["completion_tokens"]), pick(usage, ["completion_tokens"])),
        total_tokens: add(pick(base, ["total_tokens"]), pick(usage, ["total_tokens"]))
    }
}

/**
 * 渐进式回答：把一次长回答拆成若干短请求，每段一返回就回调。
 *
 * 平台上 fetch 只在响应结束时回调一次，拿不到 SSE 的增量 chunk，
 * 所以这里用「分段续写」：首段 1~2 秒就能上屏，之后一段段往后接，
 * 配合页面的逐字渲染，体感接近流式，且每段之间都可以取消。
 *
 * options: { maxTokens 总预算, segmentTokens 单段预算, onDelta(full), isCancelled() }
 */
export async function chatProgressive(messages, options) {
    options = options || {}
    const model = options.model || getModel()
    const totalBudget = options.maxTokens || getMaxTokens()
    // 单段 120~260 token：太短会频繁往返，太长首字又要等
    const segmentTokens = options.segmentTokens || Math.min(240, Math.max(120, Math.round(totalBudget / 6)))
    const maxSegments = Math.max(1, Math.min(10, Math.ceil(totalBudget / segmentTokens)))
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : function () {}
    const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : function () { return false }

    const convo = messages.slice()
    let full = ""
    let usage = null
    let finish = ""

    for (let i = 0; i < maxSegments; i++) {
        if (isCancelled()) break
        // 分段续写时每段共享输出预算，只能关掉思考，否则每段都被推理吃光
        const req = buildChatRequest(model, convo, segmentTokens, false)
        const data = await request(req.path, {
            body: req.body,
            timeout: 60000,
            retries: 0
        })

        const answer = readAnswer(data)
        // 续写拼接要保留原始空白，不能用 trim 过的版本，否则段间空格会丢
        const piece = answer.raw
        usage = mergeUsage(usage, answer.usage)
        finish = answer.finish

        if (!piece) {
            if (!full) throw createError("模型返回了空内容，请重试", 502, 502)
            break
        }

        full += piece
        onDelta(full, i)

        // 只有被 max_tokens 截断才值得续写；stop / content_filter 都应当收尾
        if (finish !== "length") break

        convo.push({ role: "assistant", content: full })
        convo.push({
            role: "user",
            content: "从断点继续往下写，直接接着上文，不要重复已写内容，不要重新开头，不要加前言或总结。"
        })
    }

    if (!full) throw createError("模型返回了空内容，请重试", 502, 502)
    return { content: full.trim(), reasoning: "", usage, model }
}

/**
 * 【当前未启用】让模型判断「这个问题要不要联网」。
 *
 * 已从首页流程移除：模型倾向于把问题改写成更窄的检索词（例如把
 * 「小米 Watch S5 什么时候发布的」压成「小米 S5 发布」），搜回来的
 * 结果和原意对不上，模型拿着摘要只能说「不知道」。现在改成联网开关
 * 一开就直接问用户，检索词用原话，不再经过这层判断。
 *
 * 保留代码是为了回退和排查，没有调用点；改回旧流程需要同时恢复
 * index.ux 里对 judgeSearchNeed / shouldSearch 的引用。
 *
 * 只发一次极轻的请求：不开思考、max_tokens 64、不给历史，
 * 免得判定本身又拖两秒。返回 { need, query, failed }：
 *  - failed=true 表示模型没按格式回，调用方应回退本地启发式规则；
 *  - 超时/网络错误直接抛，由调用方兜住，不阻断正式回答。
 */
const SEARCH_JUDGE_PROMPT = [
    "你是检索调度器，只做一件事：判断用户的问题是否需要联网查最新信息。",
    "需要联网：新闻、股价汇率、比分赛程、天气、价格、政策新规、近期发布的产品，以及你不确定或可能已经变化的事实。",
    "不需要联网：闲聊寒暄、写作翻译、算术、编程、常识与原理性解释。",
    "只输出一行 JSON，不要解释，不要代码块：",
    '{"search":true,"query":"检索关键词"}',
    '{"search":false}',
    "query 保留人名、地名、数字、时间等限定词，不超过 30 个字。"
].join("\n")

export async function judgeSearchNeed(question) {
    const q = String(question || "").trim().slice(0, 300)
    if (!q) return { need: false, query: "", failed: false }

    const model = getModel()
    const req = buildChatRequest(model, [
        { role: "system", content: SEARCH_JUDGE_PROMPT },
        { role: "user", content: q }
    ], 64, false)

    // 判定失败要快速失败：12 秒还没回就直接走本地规则，别让用户干等
    const data = await request(req.path, { body: req.body, timeout: 12000, retries: 0 })
    const answer = readAnswer(data)
    const decision = parseSearchDecision(answer.content)
    logger.log(`[ai] search judge: need=${decision.need} ok=${decision.ok} query=${decision.query}`)
    return {
        need: decision.need,
        query: decision.query || q,
        failed: !decision.ok
    }
}

/**
 * 把口语化的提问压成检索词。
 *
 * 搜索接口吃的是关键词，不是整句问话。直接把「现在他们联网搜索出来的
 * 全是 GitHub 和一些不知道是什么东西的内容」丢进去，召回会跑偏到技术站点；
 * 压成「联网搜索 结果 质量」这类词组才搜得准。
 *
 * 关键在上下文：用户很少把话说全，「那它多少钱」「这个还支持吗」都要靠上文补全。
 * 所以这里把**整个会话**给模型，不截条数、不截字数——只给最近几轮时，
 * 话题一旦跨过截断点（前面定过的型号、地点、预算），提炼出来的词就会丢对象，
 * 对话越长偏得越远。上下文由服务端处理，不占手表内存。
 * 只改写检索词，不决定搜不搜——搜不搜已经由用户在确认条上拍板了。
 */
const QUERY_PROMPT = [
    "你是搜索词生成器。结合对话上下文和用户这次的问题，写出最适合搜索引擎的检索词。",
    "只输出检索词本身，不要解释，不要加引号，不要输出句子。",
    "先判断这次问的到底是什么：如果是对上文的追问，把上文中提到的对象、型号、地点、时间补进检索词；如果是新话题，就只按这次的问题写，不要把上文内容混进来。",
    "保留人名、地名、产品型号、数字和时间；去掉「请问」「帮我」「怎么样」这类口头语。",
    "只有问题明确指向近期信息时才加 after:年份 这样的限定，没有明确时间指向就不要加。",
    "多个要点用空格分开，总长不超过 30 个字。"
].join("")

/**
 * 重搜用的提示词：上一轮的词没搜到有用东西，必须换一个角度。
 *
 * 不是简单地把原句丢回去——模型已经知道用户到底在问什么，
 * 它比原句更清楚该往哪个方向换：同义词、上位词、更具体的型号、
 * 英文原名、去掉过窄的限定词，都是比「重发一遍」更有希望的走法。
 */
const REBUILD_PROMPT = [
    "你是搜索词生成器。上一次的检索词没有搜到有用的结果，现在换一个角度重写。",
    "只输出检索词本身，不要解释，不要加引号，不要输出句子。",
    "不要重复上一轮的词，也不要只调换词序、加个年份了事：可以换同义词、换上位词或更具体的词、改用英文原名、去掉过窄的限定词，或者换成另一种说法。",
    "结合对话上下文把「它」「这个」还原成具体对象，保留人名、地名、产品型号、数字和时间。",
    "多个要点用空格分开，总长不超过 30 个字。"
].join("")

/**
 * 历史里可能夹着联网搜索抓回来的网页正文（<search_results>…</search_results>）。
 * 那是上一轮的资料，不是对话内容，提炼检索词时用不上，留着只会把请求撑大、
 * 让模型在几万字的网页里找不着重点。这里只剥掉资料块，对话本身一字不删。
 */
function stripSearchContext(content) {
    return String(content || "")
        .replace(/<search_results>[\s\S]*?<\/search_results>/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

/**
 * @param {string} question 用户原话
 * @param {Array}  history  之前的全部对话（不含本次提问）
 * @param {string} avoid    上一轮用过的检索词；有值时按「换角度重写」处理
 */
export async function buildSearchQuery(question, history, avoid) {
    const q = String(question || "").trim()
    if (!q) return ""

    const skip = String(avoid || "").trim()
    let system = QUERY_PROMPT
    if (skip) {
        system = REBUILD_PROMPT + `上一轮的检索词是「${skip}」，不要与它相同。`
    }
    const list = [{ role: "system", content: system }]
    // 整个会话都给他：话题是滚动的，截到第 9 条之前，「那个型号」就没了出处。
    // 单条也不截字——助手回复里的型号、价格、结论往往就在后半段。
    if (Array.isArray(history) && history.length) {
        for (let i = 0; i < history.length; i++) {
            const m = history[i]
            const text = stripSearchContext(m && m.content)
            if (!text) continue
            list.push({
                role: m.role === "assistant" ? "assistant" : "user",
                content: text
            })
        }
    }
    list.push({ role: "user", content: q })

    const model = getModel()
    const req = buildChatRequest(model, list, 48, false)

    // 15 秒：现在要读整个会话，长对话的输入比以前的 8 条大不少，
    // 但也不能再放宽——提炼只是搜索前的一步，不能把用户晾在状态条上
    const data = await request(req.path, { body: req.body, timeout: 15000, retries: 0 })
    const answer = readAnswer(data)
    let text = String(answer.content || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[\n\r]/g, " ")
        .replace(/^\s*(检索词|关键词|query)\s*[:：]\s*/i, "")
        .replace(/["'“”‘’「」『』]/g, "")
        .trim()

    // 模型偶尔会解释一通，超过 40 字或带句号就当作没提炼成功
    if (!text || text.length > 40 || /[。！？]/.test(text)) return ""
    return text
}

/**
 * 官方联网搜索。返回 results 数组；无结果时为空数组。
 * 文档：POST /v1/tools/search，query 1~128 字符，count 1~50。
 * 只有 DeepSeek 提供这个接口，内置模式直接返回空，由调用方退回普通对话。
 *
 * 第一次结果质量不够时，用「原问题」换一个口径再搜一次，最多一次。
 * 提炼词窄但准，原句宽但能撞到别的站点，两种口径合起来的召回面才够。
 * 重搜后两批合并去重再排序，第一次里的高分条目不会因为重搜被丢掉。
 *
 * @param {string} query        提炼后的检索词
 * @param {string} oriQuestion  用户原话，用作 ori_question
 * @param {{history?:Array, onStage?:(kind:string,word?:string)=>void}} opts
 *        history 供重搜时重新提炼用；onStage 通知页面当前阶段
 */
export async function searchWeb(query, oriQuestion, opts) {
    if (!isSearchSupported()) return []
    const q = String(query || "").trim().slice(0, 128)
    if (!q) return []

    const options = opts || {}
    const origin = String(oriQuestion || "").trim().slice(0, 128)
    let raw = await fetchSearchResults(q, origin, 50000)
    let scored = scoreResults(raw)

    if (needRetry(scored)) {
        // 第一次的词没搜到东西，让模型看着上下文再提炼一次（换个角度）。
        // 之前的做法是直接把原话丢回去重搜——原话宽是宽，但和第一次的词
        // 往往只差几个虚词，撞回同一批站点的概率很高，等于白搜一次。
        logger.log(`[ai] search 低分重搜：${scored.total} 条，最高 ${scored.top.toFixed(2)} 分，优质 ${scored.good} 条 → 重新提炼`)
        notifyStage(options.onStage, "refine")
        const retryQuery = await refineRetryQuery(origin || q, options.history, q)
        if (retryQuery) {
            logger.log(`[ai] search 重提炼检索词「${retryQuery}」`)
            notifyStage(options.onStage, "search", retryQuery)
            try {
                const second = await fetchSearchResults(retryQuery, origin, SEARCH_RETRY_TIMEOUT)
                if (second.length) {
                    raw = mergeUnique(raw, second)
                    scored = scoreResults(raw)
                    logger.log(`[ai] search 重搜合并 ${raw.length} 条 → 保留 ${scored.list.length} 条，最高 ${scored.top.toFixed(2)} 分，优质 ${scored.good} 条`)
                } else {
                    logger.warn("[ai] search 重搜无结果，沿用第一次")
                }
            } catch (e) {
                // 重搜失败不影响已拿到的结果
                logger.warn(`[ai] search 重搜失败，沿用第一次：${JSON.stringify(e)}`)
            }
        } else {
            // 连模型也给不出另一个词（或给的和第一次一样），就不做无意义的重复请求
            logger.warn("[ai] search 重提炼失败或与首次同词，不再重搜")
        }
    }

    const results = scored.list
    if (results.length) {
        let withContent = 0
        let withFallback = 0
        for (let i = 0; i < results.length; i++) {
            const r = results[i] || {}
            if (String(r.content || "").trim()) withContent++
            else if (String(r.summary || r.snippet || "").trim()) withFallback++
        }
        logger.log(`[ai] search: 原始 ${raw.length} 条 → 保留 ${results.length} 条，正文 ${withContent} 条，摘要兜底 ${withFallback} 条`)
    } else {
        logger.warn("[ai] search: 接口返回空结果")
    }
    return results
}

/** 单次搜索请求，返回接口原始 results 数组 */
async function fetchSearchResults(q, oriQuestion, timeout) {
    const body = {
        query: q,
        // 固定 10 条，不交给调用方改，也不依赖接口默认值。
        // 条数固定，每次的资料来源面才一致——写死 8 时，需要多来源对比的问题
        // 经常只回来五六条，回答就容易片面；接口按请求次数计费，条数不影响价格。
        count: SEARCH_COUNT,
        // 要正文，不要摘要：summary 是二次加工的概括，数字和限定条件常被抹掉，
        // 模型读它容易答偏。need_content=true 直接拿网页正文。
        need_content: true
    }
    // 原始问题单独带上，接口会用它校正搜索意图——
    // 「那它多少钱」这种指代句，光看检索词是猜不出在问什么的
    if (oriQuestion) body.ori_question = oriQuestion

    // 不重试：单次超时再翻一倍等待，手表上等 90 秒比直接退回无资料更糟。
    // 服务端抓正文通常 5~20 秒，50 秒还没回基本就是不通了。
    const data = await request("/v1/tools/search", { body, timeout, retries: 0 })
    return data && Array.isArray(data.results) ? data.results : []
}

/** 去掉空白和标点后比较，避免「DeepSeek 价格」和「deepseek价格」被当成两个词 */
function sameQuery(a, b) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[\s,，。.、？?！!：:「」"'“”]/g, "")
    return !!norm(a) && norm(a) === norm(b)
}

/** 页面回调包一层：回调抛错不能影响搜索流程 */
function notifyStage(onStage, kind, word) {
    if (typeof onStage !== "function") return
    try {
        onStage(kind, word)
    } catch (e) {
        // 忽略
    }
}

/**
 * 重搜的检索词：让模型看着上下文重新提炼一次。
 *
 * 第一次的词是「窄而准」，如果连它都搜不到高分结果，说明这个方向本身不对；
 * 换个角度（同义词、上位词、英文原名、去掉过窄限定）才有机会撞到别的站点。
 * 模型也提炼不出来时，退回原话——只要它和第一次的词确实不同。
 * 两者都和第一次相同时就不搜了，同一个词重发只会拿回同一批结果。
 */
async function refineRetryQuery(question, history, firstQuery) {
    try {
        const word = await buildSearchQuery(question, history, firstQuery)
        if (word && !sameQuery(word, firstQuery)) return word
    } catch (e) {
        logger.warn(`[ai] search 重提炼失败：${JSON.stringify(e)}`)
    }
    const origin = String(question || "").trim().slice(0, 128)
    if (origin && !sameQuery(origin, firstQuery)) return origin
    return ""
}

/** 第一次的结果够不够用 */
function needRetry(scored) {
    if (!scored.total) return true            // 一条都没搜到
    if (scored.top < 1.2) return true         // 最高分都很低，基本是无关页
    return scored.good < SEARCH_GOOD_MIN      // 优质条数不够，回答容易片面
}

/** 两批结果合并去重：同一 URL 只留先出现的那条（第一次的正文通常更完整） */
function mergeUnique(first, second) {
    const seen = {}
    const out = []
    const push = (item) => {
        if (!item) return
        const url = String(item.url || "").trim()
        const key = url ? url.split("#")[0].replace(/\/+$/, "") : "t:" + String(item.title || "").trim()
        if (!key || seen[key]) return
        seen[key] = 1
        out.push(item)
    }
    for (let i = 0; i < first.length; i++) push(first[i])
    for (let i = 0; i < second.length; i++) push(second[i])
    return out
}

/**
 * 按相关性排序、丢弃明显不相关的条目，并给出质量摘要。
 *
 * 接口给每条结果带 rerank_score（0~3，≥1.5 算优质）和 authority（-1~4，
 * ≥3 极权威）。之前一个都没看，服务端返回 8 条就原样塞给模型，于是
 * GitHub 仓库页、聚合站这类 0.x 分的结果混进来，把真正有用的挤掉了。
 *
 * @returns {{list:Array, total:number, top:number, good:number}}
 *          list 保留的条目，total 原始条数，top 最高分，good 优质条数
 */
function scoreResults(list) {
    if (!list || !list.length) return { list: [], total: 0, top: 0, good: 0 }

    const scored = []
    for (let i = 0; i < list.length; i++) {
        const item = list[i]
        if (!item) continue
        const score = Number(item.rerank_score)
        const authority = Number(item.authority)
        scored.push({
            item,
            score: isFinite(score) ? score : 1.5,      // 字段缺失时按中位处理，不误伤
            authority: isFinite(authority) ? authority : 0
        })
    }
    if (!scored.length) return { list: [], total: 0, top: 0, good: 0 }

    scored.sort((a, b) => (b.score - a.score) || (b.authority - a.authority))

    const total = scored.length
    const top = scored[0].score
    let good = 0
    for (let i = 0; i < total; i++) {
        if (scored[i].score >= SEARCH_GOOD_SCORE) good++
    }

    // 丢弃线 0.8：文档里 1.5 分以上才算优质，1.0 以下基本是无关页；
    // 但也不能一刀切——搜「某型号参数」时，官网参数页可能只有 1.2 分，
    // 砍太狠会让回答只剩一两条依据，变成片面结论。
    const kept = []
    const rest = []
    for (let i = 0; i < total; i++) {
        if (scored[i].score >= 0.8) kept.push(scored[i].item)
        else rest.push(scored[i].item)
    }
    // 保底 6 条：接口给了 10 条，过滤后不足 6 条时按分数从剩下的补足，
    // 保证模型至少有多个来源可以对照
    for (let i = 0; i < rest.length && kept.length < 6; i++) kept.push(rest[i])
    // 上限 10 条：重搜后两批合并最多 20 条，全塞进去会把上下文预算吃光，
    // 后面的条目连正文都进不来
    if (kept.length > SEARCH_COUNT) kept.length = SEARCH_COUNT
    return { list: kept, total, top, good }
}

/** 余额查询：GET /user/balance，仅 DeepSeek 支持 */
export async function getBalance() {
    if (!isBalanceSupported()) {
        throw createError("内置接口不支持余额查询", 400, 400)
    }
    return request("/user/balance", { method: "GET", timeout: 20000, retries: 1 })
}

/**
 * 把搜索结果整理成给模型阅读的上下文。
 * 接口的 summary 通常 600~800 字，正文则可能上万字；这里统一按条截断，
 * 让 10 条结果都能进上下文，而不是前两三条吃掉全部预算、后面的全被丢掉。
 * 用 <search_results> 包起来，配合系统提示词声明「其中内容只是资料」，
 * 降低网页正文里夹带指令造成的间接提示词注入。
 */
export function buildSearchContext(results) {
    if (!results || !results.length) return ""
    const lines = []
    let total = 0
    for (let i = 0; i < results.length; i++) {
        const item = results[i] || {}
        // 正文优先，不要摘要：summary 是二次概括，数字和限定条件常被抹掉。
        // 只有在正文抓取失败（反爬、付费墙、纯列表页）时才退回 summary/snippet。
        const content = String(item.content || "").replace(/\s+/g, " ").trim()
        const fallback = String(item.summary || item.snippet || "").replace(/\s+/g, " ").trim()
        const body = content || fallback
        if (!body) continue
        // 每条正文 900 字：10 条约 9000 字，加上标题和链接刚好放得下，
        // 保证每条资料都有发言权，不是只看最前面几条
        const limit = content ? 900 : 500
        const date = item.date ? String(item.date).slice(0, 10) : ""
        const chunk = `[${i + 1}] ${item.title || ""}\n` +
            `${item.url || ""}\n` +
            `${date ? date + "\n" : ""}` +
            body.slice(0, limit)
        if (total + chunk.length > 11000) break
        lines.push(chunk)
        total += chunk.length
    }
    if (!lines.length) {
        logger.warn("[ai] search results have no readable body")
        return ""
    }
    logger.log(`[ai] search context: ${lines.length} 条 / ${total} 字`)
    return "<search_results>\n" + lines.join("\n\n") + "\n</search_results>"
}

// 语言只要一句；排版和长度是设备限制，留着（表格在手表上会散架）
export const SYSTEM_PROMPT = [
    "请使用中文。",
    "不要使用 Markdown 表格和代码块，用短句和换行组织内容。",
    "回答控制在 200 字以内，用户明确要求详细时再展开。"
].join("")
