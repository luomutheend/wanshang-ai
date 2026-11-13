/**
 * 启动/存储自诊断。
 *
 * 用一个极小的计数器和独立的测试文件，确认这台设备上：
 * 1) @system.storage 是否真的能写后读回；
 * 2) internal://files 是否真的能写后读回；
 * 3) 每次启动计数是否递增（不递增说明应用数据被系统/安装器清掉）。
 */

import file from "@system.file"
import storage from "@system.storage"
import { asyncify } from "./async"

const DIR = "internal://files/dsdata/"
export const COUNTER_STORAGE_KEY = "deepseek_launch_count_v1"
const COUNTER_FILE = DIR + "launch.txt"

async function ensureDir() {
    if (!file || typeof file.mkdir !== "function") return
    try {
        await asyncify(file.mkdir, { uri: DIR, recursive: true })
    } catch (e) {
        // 已存在或平台不支持时忽略
    }
}

async function storageRead(key) {
    if (!storage || typeof storage.get !== "function") return null
    try {
        const res = await asyncify(storage.get, { key })
        const data = typeof res === "string" ? res : (res && res.data)
        return typeof data === "string" ? data : ""
    } catch (e) {
        return null
    }
}

async function storageWrite(key, value) {
    if (!storage || typeof storage.set !== "function") return false
    try {
        await asyncify(storage.set, { key, value })
        return true
    } catch (e) {
        return false
    }
}

async function fileRead(uri) {
    if (!file || typeof file.readText !== "function") return null
    try {
        const res = await asyncify(file.readText, { uri })
        return res && typeof res.text === "string" ? res.text : null
    } catch (e) {
        return null
    }
}

async function fileWrite(uri, text) {
    if (!file || typeof file.writeText !== "function") return false
    try {
        await asyncify(file.writeText, { uri, text })
        return true
    } catch (e) {
        return false
    }
}

export async function runStorageDiagnostics() {
    await ensureDir()

    const prevStorage = Number(await storageRead(COUNTER_STORAGE_KEY)) || 0
    const prevFile = Number(await fileRead(COUNTER_FILE)) || 0
    const count = Math.max(prevStorage, prevFile) + 1

    await storageWrite(COUNTER_STORAGE_KEY, String(count))
    const storageOk = Number(await storageRead(COUNTER_STORAGE_KEY)) === count

    await fileWrite(COUNTER_FILE, String(count))
    const fileOk = Number(await fileRead(COUNTER_FILE)) === count

    return {
        count,
        prevStorage,
        prevFile,
        storageOk,
        fileOk
    }
}

/** 给 store 复用的目录/读写工具 */
export { ensureDir, storageRead, storageWrite, fileRead, fileWrite }
