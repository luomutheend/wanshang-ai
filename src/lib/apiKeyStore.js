/**
 * DeepSeek API Key 独立存储。
 *
 * 配置整体走 store，但 Key 是最关键的小数据，单独再存一份：
 * 系统 storage 一个键 + 私有文件兜底。
 * 正常启动只读一次 storage，读写次数越少越不容易把 Vela 拖进重启。
 *
 * 内置免费接口不需要用户 Key（Key 在 client.js 里），这里只管 DeepSeek 那份。
 */

import file from "@system.file"
import storage from "@system.storage"
import { asyncify, withTimeout } from "./async"
import { ensureDir } from "./diag"
import store from "./store"

const KEY_FILE = "internal://files/dsdata/api-key.txt"
const KEY_STORAGE = "deepseek_api_key_v1"
// 上一版「按服务商分存」的结构，只为迁移保留（只查 storage，不查同名文件）
const KEYS_STORAGE_V2 = "deepseek_api_keys_v2"

// 内存里留一份：client 请求时要同步取 Key，不能再等异步接口
let cache = null
let loaded = false
let loading = null

function normalizeKey(value) {
    // 手表键盘可能带进换行/空格，Key 本身不允许空白字符，这里一并清掉
    return String(value || "").replace(/\s+/g, "")
}

/** 展示用掩码：保留前缀 3 位与后 4 位，中间省略 */
export function maskApiKey(key) {
    const text = normalizeKey(key)
    if (!text) return ""
    if (text.length <= 10) return text.slice(0, 2) + "…"
    return text.slice(0, 3) + "…" + text.slice(-4)
}

function readStorageRaw(key) {
    if (!storage || typeof storage.get !== "function") return Promise.resolve(null)
    return withTimeout(asyncify(storage.get, { key }), 1200, "storage read timeout").then(res => {
        const text = typeof res === "string" ? res : (res && res.data)
        return typeof text === "string" ? text : null
    }).catch(() => null)
}

function readFileRaw(uri) {
    if (!file || typeof file.readText !== "function") return Promise.resolve(null)
    return withTimeout(asyncify(file.readText, { uri }), 1000, "file read timeout").then(res => {
        return res && typeof res.text === "string" ? res.text : null
    }).catch(() => null)
}

function writeStorageRaw(key) {
    if (!storage || typeof storage.set !== "function") return Promise.resolve(false)
    return withTimeout(asyncify(storage.set, {
        key: KEY_STORAGE,
        value: key
    }), 1500, "storage write timeout").then(() => true).catch(() => false)
}

function writeFileRaw(key) {
    if (!file || typeof file.writeText !== "function") return Promise.resolve(false)
    return withTimeout(asyncify(file.writeText, {
        uri: KEY_FILE,
        text: key
    }), 1500, "file write timeout").then(() => true).catch(() => false)
}

/** 从上一版的分服务商结构里取 DeepSeek 那份 */
function parseV2(text) {
    if (typeof text !== "string" || !text) return ""
    try {
        const obj = JSON.parse(text)
        if (!obj || typeof obj !== "object") return ""
        return normalizeKey(obj.deepseek)
    } catch (e) {
        return ""
    }
}

/** 把内存里的 Key 回填到配置，页面和 client 都能同步读到 */
function applyToConfig() {
    try {
        // 直接用 store 而不是 global.config：启动时 global.config 还没赋值
        store.config.deepseekApiKey = cache || ""
    } catch (e) {
        // 配置层不可用时忽略：Key 仍在内存与独立存储里
    }
}

/**
 * 启动时加载一次。顺序：单 Key → 上一版分服务商结构 → 旧文件。
 * 幂等，重复调用只会返回同一个 Promise。
 */
export function initApiKey() {
    if (loaded) return Promise.resolve(cache)
    if (loading) return loading
    loading = (async () => {
        const stored = await readStorageRaw(KEY_STORAGE)
        let key = ""
        if (stored === null) {
            // 没有标记：首次安装，或者从更老的版本升级，逐级找一遍
            // 首启/升级时的迁移：只查当前 Key 文件和上一版的 storage 记录。
            // 原来要串行读 4 个来源（3 次 file + 1 次 storage），Vela 上文件接口
            // 调用一多容易把应用拖进重启——这正是「装完第一次开就卡」的来源之一。
            // 更老的 api-keys.json 只在上一步拿到 v2 标记时才不用管，这里直接放弃，
            // 代价是老用户可能要重填一次 Key，比启动崩溃划算。
            key = normalizeKey(await readFileRaw(KEY_FILE))
            if (!key) key = parseV2(await readStorageRaw(KEYS_STORAGE_V2))
            // 不管有没有找到都写一次（空串也算标记）：
            // 之后启动只读一次 storage，不再翻文件
            await writeStorageRaw(key)
        } else {
            key = normalizeKey(stored)
        }

        cache = key
        loaded = true
        applyToConfig()
        return cache
    })()
    return loading
}

/** 同步取 Key：内存已加载就以内存为准（含用户主动清空），否则回退到配置 */
export function getApiKey() {
    if (loaded) return cache || ""
    try {
        if (global.config && typeof global.config.read === "function") {
            return normalizeKey(global.config.read(c => c.deepseekApiKey))
        }
    } catch (e) {
        // 配置未就绪时忽略
    }
    return ""
}

/**
 * 保存 Key（传空字符串即清除）。
 * 先写系统存储，成功就结束；只有 storage 不可用时才落一份文件。
 */
export async function saveApiKey(value) {
    const key = normalizeKey(value)
    cache = key
    loaded = true
    applyToConfig()
    if (await writeStorageRaw(key)) return true
    await ensureDir()
    return writeFileRaw(key)
}
