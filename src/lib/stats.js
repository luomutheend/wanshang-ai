/**
 * Token 用量统计。
 *
 * 每次对话成功后累计 usage 中的 prompt / completion / total，
 * 数据只保存在本机，用于在设置里查看大致消耗。
 */

import store from "./store"

const STATS_KEY = "tokenStats"

const EMPTY = {
    prompt: 0,
    completion: 0,
    total: 0,
    requests: 0,
    // 服务端未返回 usage、改用字符估算的次数
    estimated: 0,
    lastPrompt: 0,
    lastCompletion: 0,
    lastTotal: 0,
    lastAt: 0,
    lastModel: ""
}

function safeNumber(value) {
    const num = Number(value)
    return num > 0 ? num : 0
}

/**
 * 粗略估算 token 数：中日韩字符约 1 token / 字，其余按 3 字符 1 token。
 * 只在服务端没返回 usage 时兜底，保证统计不会一直是 0。
 */
export function estimateTokens(text) {
    const str = String(text === undefined || text === null ? "" : text)
    let cjk = 0
    let other = 0
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) >= 0x2e80) cjk++
        else other++
    }
    return Math.round(cjk + other / 3)
}

export function getStats() {
    const raw = store.get(STATS_KEY, null)
    return Object.assign({}, EMPTY, raw && typeof raw === "object" ? raw : {})
}

/**
 * 记录一次对话的 token 用量。
 * 优先用服务端返回的 usage；缺失时按 promptText / replyText 估算，
 * 并把 estimated 次数累加，设置页会提示「含估算」。
 */
export function recordUsage(usage, model, promptText, replyText) {
    let prompt = 0
    let completion = 0
    let total = 0
    let estimated = false

    if (usage) {
        prompt = safeNumber(usage.prompt_tokens || usage.input_tokens || usage.prompt_token_count)
        completion = safeNumber(usage.completion_tokens || usage.output_tokens || usage.candidates_token_count)
        total = safeNumber(usage.total_tokens) || (prompt + completion)
    }

    if (!prompt && !completion) {
        prompt = estimateTokens(promptText)
        completion = estimateTokens(replyText)
        total = prompt + completion
        estimated = true
    }

    if (!prompt && !completion && !total) return getStats()

    const stats = getStats()
    stats.prompt += prompt
    stats.completion += completion
    // 合计一律按分项相加。服务端偶尔只给 total（或把缓存命中从 total 里扣掉），
    // 直接累加 total 会出现「合计 ≠ 输入 + 输出」，页面上看着就像统计坏了。
    stats.total = stats.prompt + stats.completion
    stats.requests = safeNumber(stats.requests) + 1
    if (estimated) stats.estimated = safeNumber(stats.estimated) + 1
    stats.lastPrompt = prompt
    stats.lastCompletion = completion
    stats.lastTotal = prompt + completion
    stats.lastAt = Date.now()
    stats.lastModel = String(model || "")
    store.set(STATS_KEY, stats)
    // 回复后可能立刻退出应用，不等 300ms 防抖，马上落盘
    store.flush().catch(() => {})
    return stats
}

export function resetStats() {
    store.set(STATS_KEY, Object.assign({}, EMPTY))
}

/** 千分位格式化，手表上没有 toLocaleString，手动补逗号 */
export function formatNumber(value) {
    const num = Math.max(0, Math.round(Number(value) || 0))
    return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function formatStatsTime(timestamp) {
    if (!timestamp) return "—"
    const date = new Date(timestamp)
    const month = date.getMonth() + 1
    const day = date.getDate()
    const hour = date.getHours()
    const minute = date.getMinutes()
    const hh = hour < 10 ? "0" + hour : String(hour)
    const mm = minute < 10 ? "0" + minute : String(minute)
    return `${month}-${day} ${hh}:${mm}`
}
