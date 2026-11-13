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
 *  - round：S4 / S5 圆形表（S4 466×466，S5 480×480）
 *  - rect ：RW5 / RW6 方形表（432×514）
 *  - band ：手环 9 Pro / 10 Pro（336×480）
 *  - pill ：手环 9 / 10 胶囊屏（192×490 / 212×520）
 */

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
        label: "S4 / S5 圆形表",
        shortLabel: "圆形表 S4/S5",
        shapeText: "圆形屏",
        headerTop: 10,
        contentTop: 20,
        previewTop: 40,
        previewX: 46,
        kbShape: "circle",
        kbBottom: 0,
        kbCvalH: 0,
        contentPct: 0.86,
        statusPct: 0.78
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
        statusPct: 0.92
    },
    band: {
        key: "band",
        label: "手环 9 Pro / 10 Pro",
        shortLabel: "手环 Pro",
        shapeText: "长条圆角屏",
        headerTop: 6,
        contentTop: 10,
        previewTop: 24,
        previewX: 26,
        kbShape: "rect",
        kbBottom: 34,
        kbCvalH: 32,
        contentPct: 0.92,
        statusPct: 0.92
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
        statusPct: 0.92
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
    const isBand = source.deviceType === "band" ||
        /band|手环|9p|10p|9 pro|10 pro/.test(name) ||
        (shape !== "circle" && screenW <= 380)

    let family
    if (shape === "circle") {
        family = FAMILIES.round
    } else if (shape === "pill-shaped") {
        family = FAMILIES.pill
    } else if (isBand) {
        family = FAMILIES.band
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
        headerH: 88 + family.headerTop,
        deviceText: `${screenW}×${screenH} ${shape}`
    })
}

/** 取当前设备档案；device.getInfo() 的结果由 app.ux 放进 global.DEVICE_INFO */
export function getProfile() {
    if (cached) return cached
    cached = resolveProfile(global.DEVICE_INFO || {})
    return cached
}

/** 设备信息在启动阶段可能补全，允许重算 */
export function refreshProfile() {
    cached = null
    return getProfile()
}
