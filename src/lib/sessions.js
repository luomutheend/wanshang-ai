/**
 * 历史会话：独立存储 + 启动一次加载 + 空闲回落。
 *
 * 老版本把十几条会话塞在 store.json 的 kv 里：启动时整包 JSON.parse 进内存，
 * 随后又被 JSON.stringify 写回（storage 一份、文件一份），峰值能顶到几 MB，
 * 手表上就直接表现为「卡在启动 LOGO / 偶发启动失败」。
 *
 * 现在的做法：
 * 1) 会话走自己的键（storage + 私有文件），和配置彻底分开，配置那份 JSON 变小；
 * 2) 启动时照常加载（配置就绪后紧接着加载），但按 3 条一批让出事件循环，
 *    让渲染和 GC 有机会插进来，不是一口气把 CPU 与内存顶到峰值；
 * 3) 加载完立刻丢掉原始 JSON 对象和 kv 里的旧副本，内存里只留一份规整结果；
 * 4) 写盘合并到 1.8 秒一次（一串消息只写一次），写完立即释放那串文本；
 * 5) 空闲 12 秒后把非当前会话的正文回落到磁盘，只留最后 2 轮；
 *    用户点开时再按需读回来，读完即释放。
 *
 * 对外 API 与旧版保持一致，页面不用改调用方式。
 */

import file from "@system.file"
import storage from "@system.storage"
import store from "./store"
import { asyncify, sleep, withTimeout } from "./async"
import { ensureDir } from "./diag"

export const CURRENT_SESSION_KEY = "currentSessionId"

const STORAGE_KEY = "deepseek_sessions_v1"
const FILE_PATH = "internal://files/dsdata/sessions.json"
// 老版本把会话存在 store.json 的 kv 里，键名沿用，只用于一次性迁移
const LEGACY_KV_KEY = "chatSessions"
const LEGACY_HISTORY_KEY = "chatHistory"

const SESSION_LIMIT = 12
// 单会话保留条数。长对话要能被回答模型完整读到，30 条（15 轮）太短，
// 用户会明显感到「前面说过的它不记得了」；120 条约 60 轮，覆盖手表上的实际用法
const MESSAGE_LIMIT = 120
// 单条会话的正文预算（字符）。24000 字约合 120 条 200 字的对话；
// 12 条会话最坏情况 28 万字，但只有当前会话是热的，其余 12 秒后只留 4 条
const CHAR_BUDGET = 24000
const TITLE_LENGTH = 18
// 冷会话保留的消息条数（2 轮），完整内容留在磁盘
const COLD_KEEP = 4
// 写盘合并窗口：连续发消息时只在停顿后写一次
const WRITE_DELAY = 1800
// 空闲多久后回落冷会话正文
const COLD_DELAY = 12000
// 每处理多少条让出一次事件循环
const BATCH = 3

// 内存里唯一一份会话。null 表示还没加载。
let cache = null
let loaded = false
let loadedFrom = "无"
let dirty = false
// 启动读盘失败期间产生的改动：先存着，等加载成功再一起写。
// 以前这些改动会被 scheduleWrite 直接丢掉，退出重进就再也找不回来了。
let pendingForLoad = false
let writeTimer = null
let writeChain = Promise.resolve()
let coldTimer = null

function uid() {
    return `${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

/** 超过字符预算时从最旧的一轮开始丢，保证剩下的仍以 user 开头 */
function trimByBudget(list) {
    let total = 0
    for (let i = 0; i < list.length; i++) total += list[i].content.length
    let start = 0
    while (total > CHAR_BUDGET && start < list.length - 2) {
        total -= list[start].content.length
        start++
        if (start < list.length && list[start].role !== "user") {
            total -= list[start].content.length
            start++
        }
    }
    while (start < list.length && list[start].role !== "user") {
        total -= list[start].content.length
        start++
    }
    return list.slice(start)
}

function normalizeMessages(list) {
    if (!Array.isArray(list)) return []
    const result = []
    for (let i = 0; i < list.length; i++) {
        const item = list[i]
        if (!item) continue
        if (item.role !== "user" && item.role !== "assistant") continue
        if (!item.content) continue
        result.push({ role: item.role, content: String(item.content) })
    }
    return trimByBudget(result.slice(-MESSAGE_LIMIT))
}

function titleFromMessages(messages) {
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== "user") continue
        const text = String(messages[i].content || "").replace(/\s+/g, " ").trim()
        if (!text) continue
        return text.length > TITLE_LENGTH ? text.slice(0, TITLE_LENGTH) + "…" : text
    }
    return "新对话"
}

function parseList(text) {
    if (typeof text !== "string" || !text) return null
    try {
        const obj = JSON.parse(text)
        // v2 是 { v: 2, savedAt, list }；老格式可能直接是数组
        if (Array.isArray(obj)) return { list: obj, legacy: true, savedAt: 0 }
        if (obj && Array.isArray(obj.list)) {
            return { list: obj.list, legacy: false, savedAt: Number(obj.savedAt) || 0 }
        }
    } catch (e) {
        // 损坏的数据按「没有」处理
    }
    return null
}

async function readStorageSessions() {
    if (!storage || typeof storage.get !== "function") return { ok: false, parsed: null }
    try {
        const res = await withTimeout(
            asyncify(storage.get, { key: STORAGE_KEY }), 1200, "storage read timeout")
        const text = typeof res === "string" ? res : (res && res.data)
        // 读成功但为空：可能是首次安装，也可能上次写入失败被清掉了
        if (typeof text !== "string" || !text) return { ok: true, parsed: null }
        const parsed = parseList(text)
        // 有内容却解析不出来：写到一半或损坏，不能当空
        return parsed ? { ok: true, parsed } : { ok: false, parsed: null }
    } catch (e) {
        // Vela 的 storage.get 在 key 不存在时会走 fail（code 201）。
        // 这不是「没读到」而是「确定没有」，否则全新安装的第一次启动就会被判成
        // 读取失败，loaded 永远是 false，之后所有会话都写不进盘——历史彻底存不住。
        if (isMissingKey(e)) return { ok: true, parsed: null }
        return { ok: false, parsed: null }
    }
}

/** storage 的 key 不存在（Vela：code 201）与真正的读取失败要分开处理 */
function isMissingKey(err) {
    if (!err) return false
    if (Number(err.code) === 201) return true
    const msg = String(err.message || err).toLowerCase()
    return msg.indexOf("not found") >= 0 ||
        msg.indexOf("not exist") >= 0 ||
        msg.indexOf("no such") >= 0 ||
        msg.indexOf("not found key") >= 0
}

async function readFileSessions() {
    if (!file || typeof file.readText !== "function") return null
    try {
        const res = await withTimeout(
            asyncify(file.readText, { uri: FILE_PATH }), 1200, "file read timeout")
        return parseList(res && res.text)
    } catch (e) {
        // 首次安装时文件本来就不存在，这不算读失败
        return null
    }
}

/**
 * 读独立存储：storage 与文件两路都读，按 savedAt 取新的那份。
 *
 * 之前的写法是「storage 读到就用，读不到才看文件」。问题在于 storage 单值有体积上限：
 * 会话攒到几十 KB 之后 storage.set 开始失败，写盘自动降级到文件，可 storage 里那份
 * 旧数据还在。于是每次启动都读到旧的那份，新会话在磁盘上明明存在却永远显示不出来，
 * 表现就是「历史会话无法保存」。
 *
 * 返回 { ok, parsed }，把「确实没有历史」和「这次没读到」分开：
 * - ok=true, parsed=null：读取成功，确实没有
 * - ok=false：两路都没读到/都损坏——此时绝不能把空列表当成事实
 */
async function readPersisted() {
    const pair = await Promise.all([readStorageSessions(), readFileSessions()])
    const fromStore = pair[0]
    const fromFile = pair[1]

    const storageParsed = fromStore && fromStore.parsed
    const fileAt = fromFile ? Number(fromFile.savedAt) || 0 : 0
    const storeAt = storageParsed ? Number(storageParsed.savedAt) || 0 : 0

    let chosen = null
    if (storageParsed && fromFile) {
        // savedAt 相同（或都是老格式 0）时以 storage 为准，它是主通道
        chosen = fileAt > storeAt ? fromFile : storageParsed
        loadedFrom = chosen === fromFile ? "文件存储" : "系统存储"
    } else if (storageParsed) {
        chosen = storageParsed
        loadedFrom = "系统存储"
    } else if (fromFile) {
        chosen = fromFile
        loadedFrom = "文件存储"
    }
    if (chosen) return { ok: true, parsed: chosen }

    const storageOk = !!(fromStore && fromStore.ok)
    return { ok: storageOk, parsed: null }
}

/**
 * 启动加载。返回会话数组（可能为空），未就绪时返回 null。
 * 分两批处理：先建索引（标题/时间），再规整消息，每 3 条让出一次事件循环。
 */
export async function warmup() {
    if (loaded) return cache
    if (!store.ready) return null

    // 读盘失败期间用户可能已经发了几条消息，它们只活在内存里。
    // 重建 cache 前先留住，后面合并回去，否则这次补读成功反而把它们冲掉。
    const carried = pendingForLoad && cache && cache.length ? cache.slice() : null

    let raw = null
    let needWrite = false

    // 1) 老版本遗留：会话混在 store.json 的 kv 里（store 已经把这块摘出来了）
    const legacy = store.legacySessions || store.get(LEGACY_KV_KEY, null)
    if (Array.isArray(legacy) && legacy.length) {
        raw = legacy
        loadedFrom = "旧配置迁移"
        needWrite = true
    } else if (store.get(LEGACY_KV_KEY, null)) {
        // 空数组也清掉，避免每次启动都判断一遍
        store.remove(LEGACY_KV_KEY)
    }

    // 2) 独立存储
    if (!raw) {
        const persisted = await readPersisted()
        if (persisted.parsed) {
            raw = persisted.parsed.list
            if (persisted.parsed.legacy) needWrite = true
        } else if (!persisted.ok) {
            // 读不到 != 没有。保持 loaded=false、cache=null：
            // 页面照常能开一条空草稿，但任何写盘都会被 flushNow 的 loaded 检查挡住。
            // app.ux 会在首屏之后补读一次，成功的话历史就接回来了。
            loadedFrom = "读取失败"
            return null
        }
    }

    // 索引阶段：先全部收进来，排序后再截断。
    // 不能边收边截——raw 是写入顺序，不是更新时间顺序，先截会把最新的几条丢掉
    const list = []
    if (raw) {
        for (let i = 0; i < raw.length; i++) {
            const item = raw[i]
            if (!item || !item.id) continue
            list.push({
                id: String(item.id),
                title: String(item.title || "新对话"),
                createdAt: Number(item.createdAt) || 0,
                updatedAt: Number(item.updatedAt) || 0,
                messages: Array.isArray(item.messages) ? item.messages : [],
                cold: false,
                fullCount: 0
            })
            if (list.length % BATCH === 0) await sleep(1)
        }
    }
    // 原始对象马上断开：JSON.parse 出来的这份数据比规整后的大，
    // 早一点让它成为垃圾，比等下一轮 GC 更划算
    raw = null
    if (legacy) {
        legacy.length = 0
        store.legacySessions = null
    }

    // 消息规整阶段
    for (let i = 0; i < list.length; i++) {
        list[i].messages = normalizeMessages(list[i].messages)
        if (i > 0 && i % BATCH === 0) await sleep(1)
    }

    // 3) 更老的单对话记录也迁移成一条会话
    if (!list.length) {
        const history = store.get(LEGACY_HISTORY_KEY, null)
        if (Array.isArray(history) && history.length) {
            const messages = normalizeMessages(history)
            if (messages.length) {
                list.push({
                    id: uid(),
                    title: titleFromMessages(messages),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    messages,
                    cold: false,
                    fullCount: 0
                })
                needWrite = true
            }
            store.set(LEGACY_HISTORY_KEY, [])
        }
    }

    // 把加载失败期间攒下的会话并回来：磁盘上没有的才算新，同 id 以磁盘为准
    if (carried && carried.length) {
        const known = {}
        for (let i = 0; i < list.length; i++) known[list[i].id] = true
        for (let i = 0; i < carried.length; i++) {
            const session = carried[i]
            if (!session || !session.messages || !session.messages.length) continue
            if (known[session.id]) continue
            list.push(session)
        }
    }

    list.sort((a, b) => b.updatedAt - a.updatedAt)
    if (list.length > SESSION_LIMIT) list.length = SESSION_LIMIT
    cache = list
    loaded = true
    if (!loadedFrom || loadedFrom === "无") loadedFrom = "空"
    // 给首页一个「历史晚到」的信号：启动读失败后补读成功时，
    // 首页靠它把空草稿换成真正的会话
    global.__sessionsReadyAt = Date.now()

    // kv 里的旧副本彻底删掉：内存里已经有一份，留着只会被 store.flush 再序列化一遍
    if (store.get(LEGACY_KV_KEY, null)) store.remove(LEGACY_KV_KEY)
    if (needWrite || pendingForLoad) {
        // 迁移、以及「读盘失败期间攒下的改动」，都必须立刻落一次盘。
        // 走 flushNow 而不是直接 writeOnce，保证和后面的写盘排在同一条队列上。
        pendingForLoad = false
        dirty = true
        flushNow().catch(() => {
            // 写失败保留 dirty，后面的合并窗口会再试
        })
    }
    resetColdTimer()
    return cache
}

function ensureCache() {
    if (!cache) cache = []
    return cache
}

function nowCurrent() {
    try {
        return String(store.get(CURRENT_SESSION_KEY, "") || "")
    } catch (e) {
        return ""
    }
}

function persistable() {
    const list = cache || []
    const out = []
    for (let i = 0; i < list.length; i++) {
        const s = list[i]
        out.push({
            id: s.id,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messages: s.messages
        })
    }
    return out
}

/**
 * 写盘前把冷会话的完整正文临时补回来。
 *
 * 冷回落只留 4 条在内存，如果直接序列化，磁盘上的完整历史就被这 4 条覆盖了。
 * 这里从磁盘读一次（只发生在「有冷会话 + 确实要写盘」时，也就是用户又开始聊天），
 * 补齐后写盘，写完立刻再裁回 4 条，内存不会因此长期变大。
 */
async function hydrateColdForWrite() {
    if (!cache) return
    let hasCold = false
    for (let i = 0; i < cache.length; i++) {
        if (cache[i].cold) {
            hasCold = true
            break
        }
    }
    if (!hasCold) return
    const res = await readPersisted()
    if (!res.parsed) return
    let byId = {}
    for (let i = 0; i < res.parsed.list.length; i++) {
        const item = res.parsed.list[i]
        if (item && item.id) byId[String(item.id)] = item
    }
    for (let i = 0; i < cache.length; i++) {
        const session = cache[i]
        if (!session.cold) continue
        const item = byId[session.id]
        if (item && Array.isArray(item.messages) && item.messages.length > session.messages.length) {
            session.messages = normalizeMessages(item.messages)
        }
    }
    byId = null
    res.parsed.list.length = 0
}

/** 写完把冷会话重新裁回 4 条 */
function dehydrateCold() {
    if (!cache) return
    const currentId = nowCurrent()
    for (let i = 0; i < cache.length; i++) {
        const session = cache[i]
        if (session.id === currentId) continue
        if (session.cold && session.messages.length > COLD_KEEP) {
            session.messages = session.messages.slice(-COLD_KEEP)
        }
    }
}

async function writeOnce() {
    if (!dirty) return true
    dirty = false
    await hydrateColdForWrite()
    const payload = JSON.stringify({
        v: 2,
        savedAt: Date.now(),
        list: persistable()
    })
    dehydrateCold()

    let ok = false
    let fileWritten = false
    if (storage && typeof storage.set === "function") {
        try {
            await withTimeout(
                asyncify(storage.set, { key: STORAGE_KEY, value: payload }), 1500, "storage write timeout")
            ok = true
        } catch (e) {
            ok = false
        }
    }
    if (!ok && file && typeof file.writeText === "function") {
        try {
            await withTimeout(ensureDir(), 1200, "mkdir timeout")
        } catch (e) {
            // 目录已存在
        }
        try {
            await withTimeout(
                asyncify(file.writeText, { uri: FILE_PATH, text: payload }), 1500, "file write timeout")
            ok = true
            fileWritten = true
        } catch (e) {
            ok = false
        }
    }
    // 新数据已经落到文件里，就把 storage 里那份旧的删掉。
    // 留着它的话，下次启动会读到更旧的一份（storage 优先），
    // 新会话看着就像没保存成功。删失败也不要紧：readPersisted 会按 savedAt 取新的。
    if (fileWritten && storage && typeof storage.delete === "function") {
        try {
            await withTimeout(
                asyncify(storage.delete, { key: STORAGE_KEY }), 800, "storage delete timeout")
        } catch (e) {
            // 忽略
        }
    }
    if (!ok) {
        dirty = true
        return false
    }
    if (dirty) return writeOnce()
    return true
}

export function flushNow() {
    if (!dirty) return Promise.resolve(true)
    // 还没成功读过盘：先补读一次，读到了才能安全写。
    // 仍然读不到就保持不写——空 cache 落盘会把磁盘上的历史整包覆盖掉。
    if (!loaded) {
        return warmup()
            .then(res => (res ? flushNow() : false))
            .catch(() => false)
    }
    if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
    }
    const run = writeChain.then(() => writeOnce(), () => writeOnce())
    writeChain = run.catch(() => {})
    return run
}

function scheduleWrite() {
    dirty = true
    if (!loaded) {
        // 存储这次没读上来。改动先留在内存里，等 warmup 成功后一次性补写，
        // 不能像以前那样直接 return —— 那等于把这次会话的所有消息都扔了。
        pendingForLoad = true
        return
    }
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
        writeTimer = null
        writeOnce().catch(() => {})
    }, WRITE_DELAY)
    resetColdTimer()
}

function resetColdTimer() {
    if (coldTimer) {
        clearTimeout(coldTimer)
        coldTimer = null
    }
    coldTimer = setTimeout(() => {
        coldTimer = null
        releaseCold()
    }, COLD_DELAY)
}

/**
 * 空闲回落：当前会话之外，正文超过 2 轮的部分交给磁盘，内存里只留个摘要。
 * 有未落盘的改动时不执行——否则回落会把新消息丢掉。
 */
export function releaseCold() {
    if (!cache || dirty) return 0
    const currentId = nowCurrent()
    let freed = 0
    for (let i = 0; i < cache.length; i++) {
        const session = cache[i]
        if (session.id === currentId) continue
        if (session.cold || session.messages.length <= COLD_KEEP) continue
        session.fullCount = session.messages.length
        session.messages = session.messages.slice(-COLD_KEEP)
        session.cold = true
        freed++
    }
    return freed
}

/** 冷会话按需读回完整正文（只有用户点开时才会走这里） */
async function restoreCold(session) {
    try {
        await flushNow()
    } catch (e) {
        // 写失败也继续尝试读，读到的可能是稍旧的一份
    }
    const res = await readPersisted()
    if (!res.parsed) return false
    const list = res.parsed.list
    for (let i = 0; i < list.length; i++) {
        const item = list[i]
        if (!item || String(item.id) !== session.id) continue
        session.messages = normalizeMessages(item.messages)
        session.cold = false
        session.fullCount = 0
        list.length = 0
        return true
    }
    list.length = 0
    return false
}

function displayTitle(session) {
    if (session.title && session.title !== "新对话") return session.title
    const fromMessages = titleFromMessages(session.messages)
    return fromMessages === "新对话" ? "未命名会话" : fromMessages
}

export function formatSessionTime(timestamp) {
    const date = new Date(Number(timestamp) || 0)
    const month = date.getMonth() + 1
    const day = date.getDate()
    const hour = date.getHours()
    const minute = date.getMinutes()
    const hh = hour < 10 ? "0" + hour : String(hour)
    const mm = minute < 10 ? "0" + minute : String(minute)
    return `${month}-${day} ${hh}:${mm}`
}

export function isLoaded() {
    return loaded
}

export function loadedFromSource() {
    return loadedFrom
}

export function listSessions() {
    const list = cache || []
    const out = []
    for (let i = 0; i < list.length; i++) {
        out.push({
            id: list[i].id,
            title: list[i].title,
            createdAt: list[i].createdAt,
            updatedAt: list[i].updatedAt,
            messages: list[i].messages.slice()
        })
    }
    return out
}

/** 历史页展示用：过滤掉空会话，并带上标题与时间文案 */
export function listForDisplay() {
    const list = cache || []
    const result = []
    for (let i = 0; i < list.length; i++) {
        const session = list[i]
        if (!session.messages.length && !session.fullCount) continue
        result.push({
            id: session.id,
            title: displayTitle(session),
            timeText: formatSessionTime(session.updatedAt),
            count: session.fullCount || session.messages.length
        })
    }
    return result
}

/** 只在内存里生成一条空会话，不读列表、不写盘 */
export function createDraftSession() {
    return {
        id: uid(),
        title: "新对话",
        createdAt: Date.now(),
        updatedAt: 0,
        messages: []
    }
}

export function createSession(title) {
    const list = ensureCache()
    const session = {
        id: uid(),
        title: title || "新对话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        cold: false,
        fullCount: 0
    }
    list.unshift(session)
    if (list.length > SESSION_LIMIT) list.length = SESSION_LIMIT
    store.set(CURRENT_SESSION_KEY, session.id)
    scheduleWrite()
    return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: []
    }
}

/** 取当前会话（从内存缓存，不碰磁盘） */
export function getCurrentSession() {
    if (!cache) return null
    const currentId = nowCurrent()
    for (let i = 0; i < cache.length; i++) {
        if (cache[i].id !== currentId) continue
        return {
            id: cache[i].id,
            title: cache[i].title,
            createdAt: cache[i].createdAt,
            updatedAt: cache[i].updatedAt,
            messages: cache[i].messages.slice()
        }
    }
    if (!cache.length) return null
    // 当前会话标记丢失时，回到最近更新的一条
    store.set(CURRENT_SESSION_KEY, cache[0].id)
    return {
        id: cache[0].id,
        title: cache[0].title,
        createdAt: cache[0].createdAt,
        updatedAt: cache[0].updatedAt,
        messages: cache[0].messages.slice()
    }
}

/** 轻量探测：只返回 id / 更新时间 / 条数 */
export function getCurrentSessionSummary() {
    if (!cache) return null
    const currentId = nowCurrent()
    if (!currentId) return null
    for (let i = 0; i < cache.length; i++) {
        if (cache[i].id !== currentId) continue
        return {
            id: currentId,
            updatedAt: cache[i].updatedAt,
            count: cache[i].fullCount || cache[i].messages.length
        }
    }
    return null
}

/** 切换到指定会话；冷会话会先读回完整正文。不存在时返回 null */
export async function openSession(id) {
    if (!cache) {
        await warmup()
        if (!cache) return null
    }
    for (let i = 0; i < cache.length; i++) {
        const session = cache[i]
        if (session.id !== id) continue
        store.set(CURRENT_SESSION_KEY, id)
        // 告诉首页「这次是用户主动切的会话」，别被启动草稿的短路逻辑挡掉
        global.__sessionSwitchedAt = Date.now()
        if (session.cold) await restoreCold(session)
        return {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messages: session.messages.slice()
        }
    }
    return null
}

/**
 * 保存当前会话消息，并在标题为空时用首条用户消息补齐。
 * 只改内存，写盘交给 1.8 秒的合并窗口。
 */
export function saveMessages(sessionId, messages, isDraft) {
    const list = ensureCache()
    const normalized = normalizeMessages(messages)
    for (let i = 0; i < list.length; i++) {
        if (list[i].id !== sessionId) continue
        const session = list[i]
        session.messages = normalized
        session.cold = false
        session.fullCount = 0
        session.updatedAt = Date.now()
        if (session.title === "新对话" && normalized.length) {
            session.title = titleFromMessages(normalized)
        }
        scheduleWrite()
        return session.updatedAt
    }
    if (!isDraft) return 0
    const now = Date.now()
    list.unshift({
        id: sessionId,
        title: titleFromMessages(normalized),
        createdAt: now,
        updatedAt: now,
        messages: normalized,
        cold: false,
        fullCount: 0
    })
    if (list.length > SESSION_LIMIT) list.length = SESSION_LIMIT
    store.set(CURRENT_SESSION_KEY, sessionId)
    scheduleWrite()
    return now
}

/**
 * 启动后台收敛：会话数、消息条数、正文预算都压到当前上限。
 * 只在确实超限时写盘。
 */
export function compactSessions() {
    if (!cache || !cache.length) return 0
    let changed = cache.length > SESSION_LIMIT
    if (changed) {
        cache.length = SESSION_LIMIT
    }
    for (let i = 0; i < cache.length; i++) {
        const session = cache[i]
        if (session.cold) continue
        if (session.messages.length > MESSAGE_LIMIT) {
            session.messages = normalizeMessages(session.messages)
            changed = true
        }
    }
    if (changed) scheduleWrite()
    return cache.length
}

export function deleteSession(id) {
    if (!cache) return
    const next = []
    for (let i = 0; i < cache.length; i++) {
        if (cache[i].id !== id) next.push(cache[i])
    }
    cache = next
    if (nowCurrent() === id) store.set(CURRENT_SESSION_KEY, cache.length ? cache[0].id : "")
    scheduleWrite()
}

export function clearAllSessions() {
    cache = []
    // 用户主动清空：内存状态就是事实，允许落盘
    loaded = true
    store.set(CURRENT_SESSION_KEY, "")
    store.set(LEGACY_HISTORY_KEY, [])
    if (store.get(LEGACY_KV_KEY, null)) store.remove(LEGACY_KV_KEY)
    dirty = true
    scheduleWrite()
}

/** 应用退出/退后台：把合并窗口里的改动立刻写掉 */
export function shutdown() {
    if (coldTimer) {
        clearTimeout(coldTimer)
        coldTimer = null
    }
    return flushNow()
}
