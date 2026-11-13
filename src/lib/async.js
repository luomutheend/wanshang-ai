/**
 * 异步工具层：把 QuickApp 的 callback 风格 API 统一包装为 Promise。
 * 这一层没有任何业务逻辑，供上层（net / imagecache / im）复用。
 */

/**
 * 统一的错误对象：保留设备返回的原始 code，便于上层按错误码分流。
 */
export class ImError extends Error {
    constructor(message, code) {
        super(typeof message === "string" ? message : safeString(message))
        this.name = "ImError"
        this.code = code
    }
}

function safeString(value) {
    try {
        return JSON.stringify(value)
    } catch (e) {
        return String(value)
    }
}

/**
 * 把形如 file.readText({ success, fail, ...params }) 的接口包装为 Promise。
 * @param {(params: object) => void} func 原始函数
 * @param {object} params 业务参数（success/fail 会被本函数接管）
 */
export function asyncify(func, params) {
    return new Promise((resolve, reject) => func({
        success: resolve,
        fail: (data, code) => reject(new ImError(data, code)),
        ...params
    }))
}

/**
 * 在 ms 毫秒后 resolve；用于超时兜底与节流。
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Promise.race，但会吞掉超时分支的异常，避免未捕获拒绝。
 * @param {Promise} promise 业务 Promise
 * @param {number} ms 超时毫秒
 * @param {string} label 超时错误信息
 */
export function withTimeout(promise, ms, label = "request timeout") {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ImError(label)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}
