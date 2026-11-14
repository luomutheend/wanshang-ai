/**
 * 统一存储层：配置 + 键值缓存。
 *
 * 采用「系统 storage + 私有文件」双写：
 * - storage 适合小配置（API Key、模型、开关），是 Vela 的标准持久化方式；
 * - 文件适合会话历史这类大 JSON。
 * 任意一路写成功即可保留数据；读取时取 savedAt 最新的一份，
 * 避免某个平台文件接口不可用时，API Key 重启后丢失。
 */

import file from "@system.file"
import storage from "@system.storage"
import { asyncify, ImError, sleep, withTimeout } from "./async"
import { ensureDir } from "./diag"

const STORE_DIR = "internal://files/dsdata/"
const STORE_PATH = STORE_DIR + "store.json"
// 旧版本写在根目录，保留读取做迁移
const LEGACY_STORE_PATH = "internal://files/deepseek-store.json"
const STORAGE_KEY = "deepseek_store_v1"
// 整包写入失败（例如体积超限）时，单独兜底配置与统计
const CONFIG_STORAGE_KEY = "deepseek_config_v1"
const STATS_STORAGE_KEY = "deepseek_stats_v1"
const PERSIST_DEBOUNCE = 300

/** 对话历史在 KV 中的键名（对话页与设置页共用） */
export const CHAT_HISTORY_KEY = "chatHistory"

const DEFAULT_CONFIG = {
    // 对话接口：builtin（内置免费，免填 Key） / deepseek（用自己的 Key）
    apiMode: "builtin",
    // 内置接口的模型：列表由 GET /models 动态获取，这里只是默认值
    builtinModel: "deepseek-v4.1-flash",
    // DeepSeek 官方模型：deepseek-flash（V4.1 Flash，快） / deepseek-v4-pro（更强）
    deepseekModel: "deepseek-flash",
    // 联网搜索默认开启，可在对话页或设置页随时关闭
    deepseekSearch: true,
    // 深度思考默认关闭，保证手表上的回答速度；可在设置里打开
    deepseekThinking: false,
    deepseekMaxTokens: 1200,
    // 模型判断「需要联网」时先问用户，关掉则按开关自动搜索
    deepseekAskSearch: true,
    // 页面返回动画（滑动过渡）。低端机型上关掉能少一次合成层动画
    deepseekBackAnim: true,
    // AI 角色设定：正文与展示名，空表示默认助手
    aiPersona: "",
    aiPersonaName: ""
}

function parsePayload(raw) {
    if (typeof raw !== "string" || !raw) return null
    try {
        const obj = JSON.parse(raw)
        if (obj && typeof obj === "object" && obj.config && typeof obj.config === "object") {
            return obj
        }
    } catch (e) {
        // 损坏的数据直接忽略
    }
    return null
}

/**
 * 读整包存储。
 *
 * 返回 { ok, data }，把「确实没有数据」和「这次没读到」分开：
 * - ok=true, data=null：读取成功，确实是空的（首次安装/被系统清数据）
 * - ok=false：超时、异常，或内容损坏——此时绝不能用默认值覆盖磁盘
 *
 * 退出后立刻重进时，Vela 的 storage 经常在头一两秒不回调。原来这会
 * 被当成「没有数据」，随后 300ms 的落盘把默认配置 + 空 kv 写回去，
 * 表现就是「除了独立保存的 API Key，其他全丢」。
 */
/**
 * storage 的 key 不存在（Vela：code 201）和真正的读取失败必须分开。
 * 把「没有数据」当成「没读到」会让首次安装直接进只读模式，配置永远存不下来。
 */
function isMissingKey(err) {
    if (!err) return false
    if (Number(err.code) === 201) return true
    const msg = String(err.message || err).toLowerCase()
    return msg.indexOf("not found") >= 0 ||
        msg.indexOf("not exist") >= 0 ||
        msg.indexOf("no such") >= 0
}

async function readStoragePayload() {
    if (!storage || typeof storage.get !== "function") return { ok: false, data: null }
    try {
        // 加超时：Vela 的 storage 在启动瞬间偶发不回调，await 会一直挂到
        // 应用被系统杀掉，表现就是卡在启动 LOGO。超时按「没读到」处理。
        const res = await withTimeout(
            asyncify(storage.get, { key: STORAGE_KEY }), 1500, "storage read timeout")
        const text = typeof res === "string" ? res : (res && res.data)
        if (typeof text !== "string" || !text) return { ok: true, data: null }
        const data = parsePayload(text)
        // 有内容但解析不出来：可能是上一次写到一半，不能当成空
        return data ? { ok: true, data } : { ok: false, data: null }
    } catch (e) {
        // key 不存在 = 首次安装，属于「确实没有」，不是失败
        if (isMissingKey(e)) return { ok: true, data: null }
        return { ok: false, data: null }
    }
}

async function readStorageJson(key) {
    if (!storage || typeof storage.get !== "function") return null
    try {
        const res = await withTimeout(
            asyncify(storage.get, { key }), 1200, "storage read timeout")
        const text = typeof res === "string" ? res : (res && res.data)
        if (typeof text !== "string" || !text) return null
        const obj = JSON.parse(text)
        return obj && typeof obj === "object" ? obj : null
    } catch (e) {
        return null
    }
}

async function readFilePayload(uri) {
    if (!file || typeof file.readText !== "function") return null
    try {
        const res = await withTimeout(
            asyncify(file.readText, { uri }), 1200, "file read timeout")
        return parsePayload(res && res.text)
    } catch (e) {
        return null
    }
}

class Store {
    constructor() {
        this.config = Object.assign({}, DEFAULT_CONFIG)
        this.kv = {}
        this._timer = null
        this._dirty = false
        this._flushChain = Promise.resolve()
        this.loadSource = "无"
        this.loadedSavedAt = 0
        // 加载是否真的完成：会话模块据此判断能不能安全读 kv，
        // 避免在 store 还是空对象时把「没有历史」当成事实写回去
        this.ready = false
        // 启动时 storage 没响应：本次启动进只读模式，绝不落盘。
        // 这是「退出重进数据全丢」的根因——读不到就写默认值，把真数据盖了。
        this.loadFailed = false
        // 本次启动里用户改过的配置字段，补读时用来压过磁盘上的旧值
        this._userChanges = {}
        // 本次启动里写过的 kv 键。补读时只有这些键能压过磁盘，
        // 否则启动时读到的旧 tokenStats 会把分项里的新统计盖回去
        this._kvChanges = {}
        // 退出流程中：只尝试 storage，不再走文件兜底。
        // 销毁阶段 mkdir/writeText 很容易不回调，拖着进程退不干净。
        this.exiting = false
        // 旧版本把会话也存在这个 JSON 里。启动时把它摘出来交给 sessions 模块，
        // 不参与后面的整包持久化——会话是内存占用的绝对大头。
        this.legacySessions = null
    }

    async init() {
        // 正常路径只读一次系统存储。文件接口在 Vela 上调用次数多了容易触发重启，
        // 所以只有 storage 读不到（首次安装/被系统清数据）时才去看文件备份。
        let storageRes = await readStoragePayload()
        let earlyFiles = null
        // 一次读失败先别下结论：退出后立刻重进时 storage 服务往往还没缓过来。
        // 隔 250ms 再问一遍；同时先把文件兜底那几路发出去，别让两轮超时串起来。
        if (!storageRes.ok && !storageRes.data) {
            earlyFiles = Promise.all([
                readFilePayload(STORE_PATH),
                readStorageJson(CONFIG_STORAGE_KEY),
                readStorageJson(STATS_STORAGE_KEY)
            ])
            await sleep(250)
            storageRes = await readStoragePayload()
        }
        const storageOk = storageRes.ok
        const fromStorage = storageRes.data
        // 让出一帧再继续：解析出来的对象先落定，让渲染和 GC 有机会插进来，
        // 不要在同一次事件循环里把「读配置 + 读文件兜底 + 读分项」全部做完
        await sleep(1)
        let fromFile = null
        let fromLegacy = null
        let configMirror = null
        let statsMirror = null

        if (!fromStorage) {
            // 前面已经发出去的那三路直接复用，避免重复打 storage/file
            const [filePayload, cfgMirror, statMirror] = earlyFiles
                ? await earlyFiles
                : await Promise.all([
                    readFilePayload(STORE_PATH),
                    readStorageJson(CONFIG_STORAGE_KEY),
                    readStorageJson(STATS_STORAGE_KEY)
                ])
            fromFile = filePayload
            configMirror = cfgMirror
            statsMirror = statMirror
            if (!fromFile) {
                await sleep(1)
                fromLegacy = await readFilePayload(LEGACY_STORE_PATH)
            }
        } else {
            // storage 读到了也要看另外三路：
            // 1) 文件：整包 JSON 会随 kv 一起长大，一旦超过 storage 单值上限，
            //    写入就静默降级到文件，而 storage 里还留着上一次成功写入的旧副本，
            //    只看 storage 会一直读到旧数据（token 统计回退就是这么来的）；
            // 2) 分项：整包写失败时配置与统计会拆开单独存，那是比整包更新的数据。
            // 全部拿到，下面按 savedAt 取新的。
            const [filePayload, cfgMirror, statMirror] = await Promise.all([
                readFilePayload(STORE_PATH),
                readStorageJson(CONFIG_STORAGE_KEY),
                readStorageJson(STATS_STORAGE_KEY)
            ])
            fromFile = filePayload
            configMirror = cfgMirror
            statsMirror = statMirror
        }

        const candidates = [
            { source: "系统存储", data: fromStorage },
            { source: "文件存储", data: fromFile },
            { source: "旧文件", data: fromLegacy }
        ].filter(item => item.data)
        candidates.sort((a, b) => (Number(b.data.savedAt) || 0) - (Number(a.data.savedAt) || 0))
        const chosen = candidates[0]
        this.loadSource = chosen ? chosen.source : "无"
        this.loadedSavedAt = chosen ? Number(chosen.data.savedAt) || 0 : 0

        if (chosen) {
            const raw = chosen.data
            this.config = Object.assign({}, DEFAULT_CONFIG, raw.config)
            this.kv = raw.kv && typeof raw.kv === "object" ? raw.kv : {}
            // 会话搬出去单独存：以前它跟着 config 一起被读进内存并 JSON.parse，
            // 十几条长会话的解析峰值就能把启动内存顶满。
            if (this.kv.chatSessions) {
                this.legacySessions = this.kv.chatSessions
                delete this.kv.chatSessions
                this._schedule()
            }
            // 从文件读出的数据补写一份到 storage，完成迁移；顺便补上 v2 标记
            if (chosen.source !== "系统存储" || !raw.v2) this._schedule()
        } else {
            this.config = Object.assign({}, DEFAULT_CONFIG)
            this.kv = {}
            // 读失败时一律不写：这一次的默认值只是让界面能跑起来，
            // 一旦落盘就会把磁盘上真正的那份数据覆盖掉。
            if (storageOk) this._schedule()
        }

        // 分项兜底数据比整包更新时，以分项为准
        const chosenAt = chosen ? Number(chosen.data.savedAt) || 0 : 0
        if (configMirror && configMirror.config && (Number(configMirror.savedAt) || 0) >= chosenAt) {
            this.config = Object.assign({}, DEFAULT_CONFIG, configMirror.config)
            if (!chosen) this.loadSource = "系统存储(分项)"
        }
        if (statsMirror && statsMirror.stats && (Number(statsMirror.savedAt) || 0) >= chosenAt) {
            this.kv.tokenStats = statsMirror.stats
            if (!chosen) this.loadSource = "系统存储(分项)"
        }
        // 有任何一份可信数据（整包或分项）都不算加载失败
        this.loadFailed = !chosen && !storageOk && !configMirror && !statsMirror
        if (!this.loadFailed && !chosen && (configMirror || statsMirror)) this._schedule()
        this.ready = true
        if (this.loadFailed) {
            // 保持只读：等 retryLoad 补读成功，或者用户主动改配置时再放行
            this.loadSource = "读取失败(只读)"
        }
    }

    /**
     * 启动读失败后的补读。
     *
     * 只做「把磁盘上的数据接回来」，不覆盖用户在本次启动里已经改过的字段：
     * 合并顺序是 默认值 → 磁盘 → 本次启动的改动。
     * 返回 true 表示已解除只读。
     */
    async retryLoad() {
        if (!this.loadFailed) return true
        // 整包之外还要看两个分项：整包可能因为体积超限一直写不进去，
        // 真正最新的配置与统计只在分项里。原来补读只读整包，等于把旧值接了回来。
        const [res, cfgMirror, statMirror] = await Promise.all([
            readStoragePayload(),
            readStorageJson(CONFIG_STORAGE_KEY),
            readStorageJson(STATS_STORAGE_KEY)
        ])
        const hasAny = !!(res.data || cfgMirror || statMirror)
        if (!res.ok && !hasAny) return false
        this.loadFailed = false
        if (!hasAny) {
            // 这次读成功且确实是空的：按首次安装处理
            this.loadSource = "系统存储"
            this._schedule()
            return true
        }

        const raw = res.data || {}
        const rawAt = Number(raw.savedAt) || 0

        // 配置：整包与分项取新的一份，本次启动的改动最后覆盖
        let config = raw.config && typeof raw.config === "object" ? raw.config : null
        let configAt = config ? rawAt : -1
        if (cfgMirror && cfgMirror.config && (Number(cfgMirror.savedAt) || 0) >= configAt) {
            config = cfgMirror.config
            configAt = Number(cfgMirror.savedAt) || 0
        }
        this.config = Object.assign({}, DEFAULT_CONFIG, config || {}, this._userChanges)

        const diskKv = Object.assign({}, raw.kv && typeof raw.kv === "object" ? raw.kv : {})
        if (diskKv.chatSessions) {
            this.legacySessions = diskKv.chatSessions
            delete diskKv.chatSessions
        }
        // 分项统计比整包新：以分项为准
        if (statMirror && statMirror.stats && (Number(statMirror.savedAt) || 0) > rawAt) {
            diskKv.tokenStats = statMirror.stats
        }
        // 只有本次启动真正写过的键才压过磁盘。全量 Object.assign(diskKv, this.kv)
        // 会把启动时读进来的旧值当成新值带回去，统计就退回到上一次的数。
        for (const key in this._kvChanges) {
            if (this.kv[key] === undefined) delete diskKv[key]
            else diskKv[key] = this.kv[key]
        }
        this.kv = diskKv
        this._kvChanges = {}
        this._userChanges = {}
        this.loadSource = "系统存储(补读)"
        this.loadedSavedAt = rawAt
        this._schedule()
        return true
    }

    /** 应用即将销毁：后续落盘只走 storage，不再碰文件 */
    beginExit() {
        this.exiting = true
    }

    /** 同步读取配置片段，例如 store.read(c => c.deepseekModel) */
    read(selector) {
        return selector(this.config)
    }

    /** 修改配置并异步落盘；返回本次修改的结果 */
    write(mutator) {
        // 记下这次改的是哪几个字段：读失败补读时要用它们压过磁盘上的旧值
        const before = Object.assign({}, this.config)
        const result = mutator(this.config)
        for (const key in this.config) {
            if (this.config[key] !== before[key]) this._userChanges[key] = this.config[key]
        }
        this._schedule()
        return Promise.resolve(result)
    }

    /** 读取 KV，不存在时返回默认值 */
    get(key, fallback = null) {
        const value = this.kv[key]
        return value === undefined ? fallback : value
    }

    /** 写入 KV（异步落盘） */
    set(key, value) {
        this.kv[key] = value
        this._kvChanges[key] = true
        this._schedule()
        return Promise.resolve(value)
    }

    remove(key) {
        delete this.kv[key]
        this._kvChanges[key] = true
        this._schedule()
    }

    _schedule() {
        this._dirty = true
        if (this._timer) return
        this._timer = setTimeout(() => {
            this._timer = null
            this.flush().catch(() => {})
        }, PERSIST_DEBOUNCE)
    }

    /**
     * 立即落盘。所有写入串行排队，等待期间产生的新改动会在本轮写完后继续写，
     * 不会出现「正在写历史时保存 API Key 被丢掉」的情况。
     */
    flush() {
        const run = this._flushChain.then(
            () => this._flushOnce(),
            () => this._flushOnce()
        )
        this._flushChain = run.catch(() => {})
        return run
    }

    async _flushOnce() {
        // 没读到过磁盘上的数据就别写：此刻内存里是默认配置 + 空 kv，
        // 写下去等于把用户真实的数据整包覆盖。保留 dirty，等补读或用户主动改。
        if (!this.ready || this.loadFailed) {
            this._dirty = true
            return false
        }
        if (!this._dirty) return true
        this._dirty = false
        const savedAt = Date.now()
        // API Key 由 lib/apiKeyStore.js 单独持久化（storage + 私有文件各一份）。
        // 这里落盘前剔除，避免 store.json 里再散落一份明文密钥。
        const persistedConfig = Object.assign({}, this.config)
        delete persistedConfig.deepseekApiKey
        // 会话单独存（lib/sessions.js），这里再排除一次，
        // 防止任何旧路径把整包会话又塞回启动时必读的 JSON
        const kvToPersist = Object.assign({}, this.kv)
        delete kvToPersist.chatSessions
        let text = JSON.stringify({
            // v2：双写改为「storage 为主、文件仅兜底」，有标记就不再读文件比对
            v2: 1,
            config: persistedConfig,
            kv: kvToPersist,
            savedAt
        })

        let persisted = false
        let lastError = null

        if (storage && typeof storage.set === "function") {
            try {
                await withTimeout(
                    asyncify(storage.set, { key: STORAGE_KEY, value: text }), 1500, "storage write timeout")
                persisted = true
            } catch (e) {
                lastError = e
                // 整包写入失败时，拆成配置 / 统计两个小项分别保存
                try {
                    await withTimeout(asyncify(storage.set, {
                        key: CONFIG_STORAGE_KEY,
                        value: JSON.stringify({ config: persistedConfig, savedAt })
                    }), 1200, "storage write timeout")
                    persisted = true
                } catch (err) {
                    lastError = err
                }
                if (this.kv.tokenStats) {
                    try {
                        await withTimeout(asyncify(storage.set, {
                            key: STATS_STORAGE_KEY,
                            value: JSON.stringify({ stats: this.kv.tokenStats, savedAt })
                        }), 1200, "storage write timeout")
                        persisted = true
                    } catch (err) {
                        lastError = err
                    }
                }
            }
        }

        // storage 写成功就到此为止：文件只作为 storage 不可用时的兜底，
        // 避免每次保存都多打一轮 mkdir + writeText。
        let fileWritten = false
        if (!persisted && !this.exiting && file && typeof file.writeText === "function") {
            // mkdir 也可能不回调，一并限时；失败后面会退到旧路径
            try {
                await withTimeout(ensureDir(), 1200, "mkdir timeout")
            } catch (e2) {
                // 目录已存在或平台不支持：继续尝试直接写
            }
            try {
                await withTimeout(
                    asyncify(file.writeText, { uri: STORE_PATH, text }), 1500, "file write timeout")
                persisted = true
                fileWritten = true
            } catch (e) {
                lastError = e
                // 子目录不可写时退回旧路径
                try {
                    await withTimeout(
                        asyncify(file.writeText, { uri: LEGACY_STORE_PATH, text }), 1500, "file write timeout")
                    persisted = true
                    fileWritten = true
                } catch (err) {
                    lastError = err
                }
            }
        }
        // 新数据落到了文件里，就把 storage 里那份旧的删掉：
        // 留着它，下次启动会先读到旧整包，比文件旧却更"可信"，新配置和统计看着就像没保存。
        if (fileWritten && storage && typeof storage.delete === "function") {
            try {
                await withTimeout(
                    asyncify(storage.delete, { key: STORAGE_KEY }), 800, "storage delete timeout")
            } catch (e) {
                // 删不掉也不要紧：init 现在两路都读，会按 savedAt 取新的
            }
        }

        if (!persisted) {
            text = null
            this._dirty = true
            throw lastError || new ImError("保存失败")
        }
        // 写完立刻断开这串文本的引用：配置 JSON 有几十 KB，
        // 早点让它变成垃圾，别等下一轮标记清除
        text = null
        // 用户改动已经落盘，补读时不必再压过磁盘
        this._userChanges = {}
        // 写入期间如果又有新改动，继续写一轮再返回
        if (this._dirty) return this._flushOnce()
        return true
    }
}

/**
 * 全应用单例。
 *
 * Vela 打包会把 lib 分别编进每个页面各自的 JS 包，每个包里的模块作用域是独立的，
 * 直接 new 会得到多个 store：首页写入的 tokenStats / 会话，在统计页、历史页读到的是
 * 另一份空 kv（显示一直为 0），而且首页落盘还会用它自己的默认 config 覆盖已保存配置。
 * global 在同一应用的所有页面间共享，挂上去即可保证只有一份。
 */
const store = global.__dsStore || new Store()
global.__dsStore = store

export default store
