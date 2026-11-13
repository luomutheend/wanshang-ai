/**
 * 模型目录：拉取、过滤、缓存、排序。
 *
 * 百炼兼容端点的 GET /models 会返回 180 多个模型，其中一大半是
 * embedding / rerank / TTS / 图像这类根本不能聊天的，直接列出来只会
 * 让人点错。这里过滤 + 去重 + 按常用度排序，再缓存 12 小时。
 * DeepSeek 官方同样实现了 /models，两边共用这套逻辑。
 */

import storage from "@system.storage"
import { asyncify } from "./async"
import { listModels, getApiMode } from "../deepseek/client"

// 12 小时：模型上下架不会很频繁，但也不能永远用旧列表
const CACHE_TTL = 12 * 60 * 60 * 1000

/** 命中这些关键词的都不是对话模型 */
const NON_CHAT = [
    "embedding", "rerank", "tts", "asr", "audio", "realtime", "image",
    "video", "ocr", "livetranslate", "wanx", "paraformer", "cosyvoice",
    "sambert", "speech", "mt-uni", "-mt-"
]

/** 常用模型优先，省得在长列表里翻 */
const PRIORITY = [
    "deepseek-v4.1-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-0731",
    "qwen3.8-flash",
    "qwen3.8-max",
    "qwen-plus",
    "kimi-k3.1-pro",
    "glm-5.3"
]

// 同步可读的内存镜像，页面首屏直接拿它铺列表
let memory = []
let memoryMode = ""

function cacheKey() {
    return "deepseek_models_v1_" + (memoryMode || getApiMode())
}

/** 过滤掉非对话模型，并去掉 vendor/ 前缀造成的重复项 */
export function filterChatModels(ids) {
    const all = []
    const seen = {}
    for (let i = 0; i < ids.length; i++) {
        const id = String(ids[i] || "").trim()
        if (!id || seen[id]) continue
        let bad = false
        const lower = id.toLowerCase()
        for (let k = 0; k < NON_CHAT.length; k++) {
            if (lower.indexOf(NON_CHAT[k]) >= 0) {
                bad = true
                break
            }
        }
        if (bad) continue
        seen[id] = true
        all.push(id)
    }

    // `vanchin/deepseek-v4-pro` 与 `deepseek-v4-pro` 是同一个模型的两条记录，
    // 后者能用就优先保留后者
    const result = []
    for (let i = 0; i < all.length; i++) {
        const id = all[i]
        const slash = id.indexOf("/")
        if (slash > 0) {
            const bare = id.slice(slash + 1)
            if (seen[bare]) continue
        }
        result.push(id)
    }
    return result
}

function priorityOf(id) {
    const index = PRIORITY.indexOf(id)
    if (index >= 0) return index
    if (id.indexOf("deepseek") === 0) return 100
    if (id.indexOf("qwen") === 0) return 200
    return 300
}

/** 常用在前，其余按字母 */
export function sortModels(ids) {
    const list = ids.slice()
    list.sort((a, b) => {
        const pa = priorityOf(a)
        const pb = priorityOf(b)
        if (pa !== pb) return pa - pb
        return a < b ? -1 : (a > b ? 1 : 0)
    })
    return list
}

/** 拉回来的原始 id 列表 → 可直接展示的列表 */
export function normalizeModels(ids) {
    return sortModels(filterChatModels(ids || []))
}

export function getCachedModels() {
    return memoryMode === getApiMode() ? memory.slice() : []
}

async function readCache(mode) {
    try {
        const raw = await asyncify(storage.get, { key: "deepseek_models_v1_" + mode })
        // 不同固件返回字符串或 { data: "..." } 两种形状
        const text = typeof raw === "string" ? raw : (raw && raw.data)
        const obj = typeof text === "string" ? JSON.parse(text) : text
        if (!obj || !Array.isArray(obj.list) || !obj.list.length) return null
        if (Date.now() - (Number(obj.at) || 0) > CACHE_TTL) return null
        return obj.list
    } catch (e) {
        return null
    }
}

async function writeCache(mode, list) {
    memory = list
    memoryMode = mode
    try {
        await asyncify(storage.set, {
            key: "deepseek_models_v1_" + mode,
            value: JSON.stringify({ at: Date.now(), list })
        })
    } catch (e) {
        // 缓存写失败不影响本次使用
    }
}

/**
 * 取模型列表：内存 → 缓存 → 接口。
 * force=true 时跳过缓存直接打接口（模型页「刷新」用）。
 */
export async function loadModels(force) {
    const mode = getApiMode()
    if (memoryMode !== mode) memory = []

    if (!force && memory.length) return memory.slice()

    if (!force) {
        const cached = await readCache(mode)
        if (cached) {
            memory = cached
            memoryMode = mode
            return cached.slice()
        }
    }

    const ids = await listModels()
    const list = normalizeModels(ids)
    if (!list.length) throw new Error("接口没有返回可用模型")
    await writeCache(mode, list)
    return list.slice()
}
