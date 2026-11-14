/**
 * 设备适配档案。
 *
 * Vela 里样式 px 是设备物理像素（1:1），百分比才是相对屏幕宽度的。
 * 所以这里所有尺寸都用「物理 px」，并按机型屏幕宽度算出：
 *  - 键盘缩放系数（把按 640 / 480 宽设计的键盘整体缩到屏幕宽度）
 *  - 预览区高度（屏幕高 - 键盘实际高度）
 *  - 内容安全宽度（避开四角圆弧）
 *
 * 设备族：
 *  - round   ：S4 466×466 圆表
 *  - roundBig：S5 / S5 eSIM 480×480 圆表（圆角更大，安全边距另算）
 *  - rect    ：RW5 / RW6 方形表（432×514）
 *  - band    ：小屏手环（宽 < 300）
 *  - bandPro ：手环 9 Pro / 10 Pro（336×480 长条圆角屏，圆角半径大、
 *              上下留白要比小屏手环多一些，否则标题和首行会被弧角吃掉）
 *  - pill    ：手环 9 / 10 胶囊屏（192×490 / 212×520）
 *
 * 构建时若指定了 WANSHANG_TARGET（见 quickapp.config.js），
 * 直接采用该机型的固定参数，不再读运行时探测结果。
 */

import { BUILD_TARGET } from "../buildinfo"

const REF_WIDTH = 466

let cached = null

function num(value, fallback) {
    const n = Number(value)
    return n > 0 ? n : fallback
}

function normalizeShape(info) {
    const raw = info && info.screenShape
    if (raw === "circle" || raw === "rect" || raw === "pill-shaped") return raw
    const w = num(info && info.screenWidth, 0)
    const h = num(info && info.screenHeight, 0)
    if (w && h) {
        const ratio = Math.min(w, h) / Math.max(w, h)
        if (ratio < 0.55) return "pill-shaped"
        if (ratio < 0.85) return "rect"
    }
    return "circle"
}

const FAMILIES = {
    round: {
        key: "round",
        label: "S4 圆形表 466",
        shortLabel: "圆屏 466",
        shapeText: "圆形屏",
        headerTop: 10,
        contentTop: 20,
        previewTop: 40,
        previewX: 46,
        kbShape: "circle",
        kbBottom: 0,
        kbCvalH: 0,
        contentPct: 0.86,
        statusPct: 0.78,
        imeInset: 8
    },
    // 480 圆屏：圆角半径比 466 大一圈，内容左右各再收 2%，
    // 否则设置页的行和输入法预览会贴到弧边上
    roundBig: {
        key: "round",
        label: "S5 圆形表 480",
        shortLabel: "圆屏 480",
        shapeText: "圆形屏",
        headerTop: 12,
        contentTop: 22,
        previewTop: 44,
        previewX: 52,
        kbShape: "circle",
        kbBottom: 0,
        kbCvalH: 0,
        contentPct: 0.84,
        statusPct: 0.76,
        imeInset: 8
    },
    rect: {
        key: "rect",
        label: "RW5 / RW6 方形表",
        shortLabel: "方屏表 RW5/6",
        shapeText: "圆角方形屏",
        headerTop: 8,
        contentTop: 12,
        previewTop: 16,
        previewX: 22,
        kbShape: "rect",
        kbBottom: 34,
        kbCvalH: 32,
        contentPct: 0.92,
        statusPct: 0.92,
        imeInset: 8
    },
    band: {
        key: "band",
        label: "小屏手环",
        shortLabel: "小屏手环",
        shapeText: "长条圆角屏",
        headerTop: 6,
        contentTop: 10,
        previewTop: 24,
        previewX: 26,
        kbShape: "rect",
        kbBottom: 34,
        kbCvalH: 32,
        contentPct: 0.92,
        statusPct: 0.92,
        imeInset: 14
    },
    // 336×480（手环 9 Pro / 10 Pro）：屏更宽更高，但四角圆弧半径也更大。
    // 内容宽收到 86%，顶部留白翻倍，避免标题栏和第一行被圆角切掉。
    bandPro: {
        key: "band",
        label: "手环 Pro 336×480",
        shortLabel: "手环 Pro",
        shapeText: "长条圆角屏",
        headerTop: 26,
        contentTop: 34,
        previewTop: 40,
        previewX: 24,
        kbShape: "rect",
        kbBottom: 30,
        kbCvalH: 30,
        contentPct: 0.86,
        statusPct: 0.86,
        imeInset: 18
    },
    pill: {
        key: "pill",
        label: "手环 9 / 10 胶囊屏",
        shortLabel: "胶囊手环",
        shapeText: "胶囊屏",
        headerTop: 6,
        contentTop: 10,
        previewTop: 10,
        previewX: 12,
        kbShape: "pill-shaped",
        kbBottom: 0,
        kbCvalH: 32,
        contentPct: 0.92,
        statusPct: 0.92,
        imeInset: 10
    }
}

/**
 * 方屏 / 手环键盘：与 QQ 同一套设计稿，全部用设计单位 px。
 * 字母键 60px、间距 4px，一行 10 键 = 640px；视口 466px（=整屏宽），
 * 剩余 174px 靠横向滑动查看，因此任何屏宽的方屏设备右侧都铺满、不会被裁。
 */
export const RECT_KEYBOARD = {
    key: 60,
    gap: 5,
    bar: 60,
    space: 78,
    font: 30,
    viewport: REF_WIDTH,
    height: 255
}

export function resolveProfile(info) {
    const source = info || {}
    const screenW = num(source.screenWidth, REF_WIDTH)
    const screenH = num(source.screenHeight, REF_WIDTH)
    const shape = normalizeShape(source)

    const name = `${source.brand || ""} ${source.model || ""} ${source.product || ""}`.toLowerCase()
    // 长条形（不看方向）：手环横竖两种上报都可能出现
    const longSide = Math.max(screenW, screenH)
    const shortSide = Math.min(screenW, screenH)
    const isBand = source.deviceType === "band" ||
        /band|手环|9p|10p|9 pro|10 pro/.test(name) ||
        (shape !== "circle" && (shortSide <= 380 && longSide / shortSide >= 1.2))

    let family
    if (shape === "circle") {
        // 474 以上按大圆屏处理：S5 系列 480，S4 466
        family = screenW >= 474 ? FAMILIES.roundBig : FAMILIES.round
    } else if (shape === "pill-shaped") {
        family = FAMILIES.pill
    } else if (isBand) {
        // 336×480 的 Pro 手环单独一档：同样长条屏，但圆角更大、留白更多
        family = shortSide >= 300 && longSide >= 460 ? FAMILIES.bandPro : FAMILIES.band
    } else {
        family = FAMILIES.rect
    }

    // px 按 designWidth 等比缩放，所以设计高度也要按屏宽换算
    const designH = Math.round(screenH * REF_WIDTH / screenW)

    // 键盘高度（设计单位）：圆屏 321、方屏/手环 255、胶囊 305
    const kbShapeH = family.key === "pill" ? 305 : (family.key === "round" ? 321 : RECT_KEYBOARD.height)
    const kbHeight = family.kbCvalH + kbShapeH + family.kbBottom
    const panelHeight = Math.max(90, designH - kbHeight)
    const contentW = Math.round(REF_WIDTH * family.contentPct)
    const statusW = Math.round(REF_WIDTH * family.statusPct)

    return Object.assign({}, family, {
        screenW,
        screenH,
        designH,
        kbHeight,
        panelHeight,
        contentW,
        statusW,
        rectKb: RECT_KEYBOARD,
        // QQ 式输入条高度（退出 / 预览 / 发送 一行）
        inputBarH: family.key === "round" ? 68 : 60,
        // 输入条左右留白：手环圆角大，贴边会被切掉一截
        imeBarLeft: family.imeInset,
        imeBarWidth: REF_WIDTH - family.imeInset * 2,
        headerH: 88 + family.headerTop,
        deviceText: `${screenW}×${screenH} ${shape}`
    })
}

/**
 * 固定机型包。一只包只覆盖同屏幕的一组机型：
 *  - rw5      ：Redmi Watch 5 / 6（2.07" AMOLED，432×514 方屏）
 *  - s5       ：Watch S5 / S5 eSIM（480×480 圆屏）
 *  - bandpro  ：手环 9 Pro / 10 Pro（1.74" AMOLED，336×480）
 *
 * 构建时 WANSHANG_TARGET 命中这里，界面参数就完全按表里的屏幕写死，
 * 不再依赖 device.getInfo()：手表上探测偶尔超时（app.ux 里只等 1000ms），
 * 一旦拿不到信息就会退回 466 的默认值，在 480 屏上整体偏小、边距也错。
 */
const FIXED_TARGETS = {
    rw5: {
        screenWidth: 432,
        screenHeight: 514,
        screenShape: "rect",
        model: "Redmi Watch 5 / 6",
        label: "Redmi Watch 5 / 6 432×514",
        shortLabel: "RW5/6"
    },
    s5: {
        screenWidth: 480,
        screenHeight: 480,
        screenShape: "circle",
        model: "Xiaomi Watch S5 / S5 eSIM",
        label: "Xiaomi Watch S5 480",
        shortLabel: "S5"
    },
    // 手环 9 Pro / 10 Pro：同为 1.74" AMOLED，官方标 480×336（竖持即 336 宽 × 480 高）
    bandpro: {
        screenWidth: 336,
        screenHeight: 480,
        screenShape: "rect",
        model: "Xiaomi Smart Band 9 Pro / 10 Pro",
        label: "小米手环 9 Pro / 10 Pro 336×480",
        shortLabel: "手环 9P/10P"
    }
}

export const BUILD_TARGET_NAME = String(BUILD_TARGET || "auto")

/** 取当前设备档案；固定机型包优先，auto 才看 device.getInfo() */
export function getProfile() {
    if (cached) return cached
    const fixed = FIXED_TARGETS[BUILD_TARGET_NAME]
    if (fixed) {
        cached = resolveProfile(fixed)
        // 机型名以构建目标为准，日志里能直接看出这是哪个包
        cached.label = fixed.label
        cached.shortLabel = fixed.shortLabel
        cached.buildTarget = BUILD_TARGET_NAME
        return cached
    }
    cached = resolveProfile(global.DEVICE_INFO || {})
    cached.buildTarget = "auto"
    return cached
}

/** 设备信息在启动阶段可能补全，允许重算 */
export function refreshProfile() {
    cached = null
    return getProfile()
}
