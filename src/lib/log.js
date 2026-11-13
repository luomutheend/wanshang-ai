/**
 * 轻量日志器。
 *
 * 相比逐条写盘，这里做了两件事：
 *  1. 日志先进入内存环形缓冲（保留最近 N 条），需要排查时可直接读取；
 *  2. 写盘按时间窗口批量追加，避免高频日志把 IO 打满（这是手表上卡顿/看门狗重启的常见诱因）。
 */

import file from "@system.file"

const MEMORY_LIMIT = 200
// 手表上 file 接口调用越少越稳，日志只是排障用，15s 批量落一次足够
const FLUSH_INTERVAL = 15000
// 手表存储有限，只保留最近几次启动的日志
const KEEP_LOGS = 3
const LOG_DIR = "internal://files/logs/"
const LEVEL_STYLE = {
    log: "color: green;",
    warn: "color: orange;",
    error: "color: red;"
}

class Logger {
    constructor() {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        this.filePath = `${LOG_DIR}log-${stamp}.log`
        this.memory = []
        this.pending = []
        this.timer = null
        this.disabled = false
        // 目录与旧日志清理推迟到第一次真正写盘时做：
        // 构造函数里打 mkdir/list 等于每次冷启动都多两次文件接口调用
        this.ready = false
    }

    /** 清理历史日志：按文件名（ISO 时间戳）排序，只留最近 KEEP_LOGS 个 */
    _cleanup() {
        if (typeof file === "undefined" || !file || !file.list) return
        const finish = (res) => {
            const list = (res && (res.fileList || res.files)) || []
            const old = []
            for (let i = 0; i < list.length; i++) {
                const item = list[i] || {}
                const uri = item.uri || item.path || item.name || ""
                if (uri && uri.indexOf("log-") >= 0 && uri !== this.filePath) old.push(uri)
            }
            old.sort()
            while (old.length > KEEP_LOGS) {
                const uri = old.shift()
                try {
                    file.delete({ uri, fail: () => {} })
                } catch (e) {
                    // 删不掉就留着，不影响主流程
                }
            }
        }
        try {
            file.list({ uri: LOG_DIR, success: finish, fail: () => {} })
        } catch (e) {
            // 部分固件没有 list 接口，跳过清理
        }
    }

    _prepareDir(onReady) {
        if (typeof file === "undefined" || !file || !file.mkdir) {
            if (onReady) onReady()
            return
        }
        file.mkdir({
            uri: LOG_DIR,
            recursive: true,
            success: () => {
                this._cleanup()
                if (onReady) onReady()
            },
            fail: () => {
                // 日志目录不可用时静默降级为纯控制台输出
                this.disabled = true
            }
        })
    }

    log(...args) { this._write("log", args) }
    warn(...args) { this._write("warn", args) }
    error(...args) { this._write("error", args) }

    /** 读取最近的内存日志（用于“导出日志/问题反馈”场景） */
    recent() {
        return this.memory.slice()
    }

    _write(level, args) {
        const timestamp = new Date().toISOString()
        const message = args.map(stringify).join(" ")
        const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`

        console.log(`%c${line}`, LEVEL_STYLE[level])

        this.memory.push(line)
        if (this.memory.length > MEMORY_LIMIT) {
            this.memory.splice(0, this.memory.length - MEMORY_LIMIT)
        }

        if (this.disabled) return
        this.pending.push(line)
        this._scheduleFlush()
    }

    _scheduleFlush() {
        if (this.timer) return
        this.timer = setTimeout(() => {
            this.timer = null
            this.flush()
        }, FLUSH_INTERVAL)
    }

    /** 立即把缓冲写入文件（退出前调用可保证不丢日志） */
    flush() {
        if (this.disabled || !this.pending.length) return
        const text = this.pending.join("\n") + "\n"
        this.pending = []
        if (typeof file === "undefined" || !file || !file.writeText) return
        // 第一次落盘时才建目录、清旧日志，把启动阶段的文件接口调用降到 0
        if (!this.ready) {
            this.ready = true
            this._prepareDir(() => this._writeFile(text))
            return
        }
        this._writeFile(text)
    }

    _writeFile(text) {
        if (this.disabled || !file || !file.writeText) return
        file.writeText({
            uri: this.filePath,
            text,
            append: true,
            fail: () => { /* 写盘失败不影响主流程 */ }
        })
    }
}

function stringify(value) {
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value)
    } catch (e) {
        return "[Unserializable]"
    }
}

const logger = new Logger()
export default logger
