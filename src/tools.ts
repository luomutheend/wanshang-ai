import { device } from "./tsimports"

export function getDeviceInformation(): Promise<any> {
    return new Promise((resolve, reject) => {
        device.getInfo({
            success: (data) => {
                resolve(data)
            },
            fail: (error) => {
                reject(error)
            }
        })
    })
}

/**
 * 归一化屏幕形状。
 * 部分设备(如 S5 系列) device.getInfo().screenShape 可能缺失或返回未知值，
 * 直接使用会导致键盘等按形状分发的组件找不到布局而空白。
 * 已知值原样返回，未知时按屏幕宽高比推断，兜底 circle。
 */
export function normalizeScreenShape(info: any): string {
    const raw = info ? info.screenShape : undefined
    if (raw === "circle" || raw === "rect" || raw === "pill-shaped") {
        return raw
    }

    const width = Number(info && info.screenWidth) || 0
    const height = Number(info && info.screenHeight) || 0
    if (width > 0 && height > 0) {
        const ratio = Math.min(width, height) / Math.max(width, height)
        if (ratio < 0.55) {
            return "pill-shaped"
        }
        if (ratio < 0.85) {
            return "rect"
        }
    }

    return "circle"
}
