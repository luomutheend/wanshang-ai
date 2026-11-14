/**
 * AI 角色设定。
 *
 * 存两个字段：
 * - aiPersona：设定正文，空串表示不额外注入
 * - aiPersonaName：设置页展示用的名字
 *
 * 为什么不存预设 id 再查表：预设文案后续可能微调，
 * 存正文能保证用户选过的设定在版本升级后不会突然变样。
 */

/** 预设人设。prompt 越短越好——手表上 system 每多一字都在抢回答预算 */
export const PERSONA_PRESETS = [
    {
        id: "default",
        name: "默认助手",
        brief: "简洁直接，不带腔调",
        prompt: ""
    },
    {
        id: "translator",
        name: "翻译官",
        brief: "只给译文，不加解释",
        prompt: "你是一名翻译。用户给中文就译成英文，给英文就译成中文，只输出译文，" +
            "不解释、不补充、不加引号。遇到专有名词保留原文并括号注明。"
    },
    {
        id: "teacher",
        name: "耐心老师",
        brief: "拆成小步骤讲",
        prompt: "你是一位耐心的老师。先用一句话给结论，再把难点拆成不超过三步，" +
            "每步配一个生活化的例子。避免术语堆砌，必须用术语时顺手解释。"
    },
    {
        id: "coder",
        name: "程序员",
        brief: "先给代码，再说坑",
        prompt: "你是一名资深工程师。回答优先给可直接运行的代码，再用两三句说明关键点和易错处。" +
            "不确定的 API 或版本行为要明说，不要编造。"
    },
    {
        id: "writer",
        name: "文案助手",
        brief: "一次给三个版本",
        prompt: "你是一名文案。同一需求给三个风格不同的短版本（克制、活泼、正式），" +
            "每个不超过 40 字，直接列出来，不解释创作思路，除非用户追问。"
    },
    {
        id: "listener",
        name: "树洞",
        brief: "先接情绪，再给建议",
        prompt: "你是一个倾听者。先复述对方的感受表示理解，再问一个具体的问题，" +
            "最后才给建议。不说教，不灌鸡汤，不轻易下判断。"
    }
]

/** 自定义设定的字数上限：再长会明显挤占回答空间 */
export const PERSONA_MAX_LENGTH = 300

function configRead(selector, fallback) {
    try {
        const config = global.config
        if (!config || typeof config.read !== "function") return fallback
        const value = config.read(selector)
        return value === undefined || value === null ? fallback : value
    } catch (e) {
        return fallback
    }
}

function configWrite(mutator) {
    try {
        const config = global.config
        if (config && typeof config.write === "function") return config.write(mutator)
        if (global.__dsStore && typeof global.__dsStore.write === "function") {
            return global.__dsStore.write(mutator)
        }
    } catch (e) {
        // 落到下面的失败分支
    }
    return Promise.reject(new Error("config unavailable"))
}

export function getPersonaPrompt() {
    return String(configRead(c => c.aiPersona, "") || "").trim()
}

/** 设置页那一行右侧显示的名字 */
export function getPersonaName() {
    if (!getPersonaPrompt()) return PERSONA_PRESETS[0].name
    return String(configRead(c => c.aiPersonaName, "") || "").trim() || "自定义"
}

/** 命中预设时返回预设 id，否则返回 custom / default */
export function getPersonaId() {
    const prompt = getPersonaPrompt()
    if (!prompt) return "default"
    for (let i = 0; i < PERSONA_PRESETS.length; i++) {
        const item = PERSONA_PRESETS[i]
        if (item.prompt && item.prompt === prompt) return item.id
    }
    return "custom"
}

export function savePersona(name, prompt) {
    const text = String(prompt || "").trim().slice(0, PERSONA_MAX_LENGTH)
    return configWrite(cfg => {
        cfg.aiPersona = text
        cfg.aiPersonaName = text ? String(name || "自定义") : ""
    })
}

/**
 * 把设定拼到基础提示词前面。
 * 放在前面而不是后面：模型对开头的角色指令服从度更高，
 * 基础提示词里的排版/字数要求仍然有效。
 */
export function applyPersona(base) {
    const prompt = getPersonaPrompt()
    if (!prompt) return base
    return "【角色设定】\n" + prompt + "\n\n【通用要求】\n" + base
}
