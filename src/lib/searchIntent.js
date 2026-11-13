/**
 * 「这次要不要联网」的本地判断。
 *
 * 开了联网搜索后，连「你好」都会先发一次网页搜索，白白多等 2~4 秒，
 * 状态条还会先闪一下「正在联网搜索…」。这里用一组启发式规则先过一遍：
 * 命中时效 / 外部事实信号就搜；寒暄、致谢、翻译改写、算术这类模型自己
 * 就能答的不搜。判断整体偏保守——拿不准时照旧搜索，漏搜比多搜更影响体验。
 */

// 明确在本地就能完成的任务：翻译、改写、创作、算数、写代码
const LOCAL_TASK = /^(请|麻烦)?(帮我)?(翻译|润色|改写|扩写|缩写|总结一下|概括|起名|取名|写一首|写一篇|写一段|写个|写一个|计算|算一下|算算|解方程|写代码|写函数|解释一下|优化一下)/

// 问时间日期：模型自己就能答，不用联网
const LOCAL_CLOCK = /^(现在|今天|请问|问一下)?(几点了?|几点钟|几号|多少号|星期几|周几|什么日子)$/

// 时效性 / 外部事实类信号：出现就该联网
const TIME_SENSITIVE = /(今天|今日|昨天|昨日|明天|后天|现在|目前|当前|最近|最新|实时|刚刚|新闻|热搜|头条|动态|进展|发布会|上市|开售|发售|价格|多少钱|报价|股价|汇率|金价|油价|票房|比分|赛程|赛果|排名|榜单|天气|气温|降雨|台风|限行|政策|规定|版本|更新日志|20[2-3]\d)/

// 寒暄、致谢、确认、问能力：不需要外部信息
const SMALL_TALK = /^(你好|您好|嗨|哈喽|在吗|在不在|早上好|中午好|下午好|晚上好|早安|晚安|谢谢|多谢|感谢|辛苦了|好的|好|嗯|哦|收到|明白了|没事|再见|拜拜|你是谁|你叫什么|你叫什么名字|你能做什么|你会什么|怎么用|帮助|hi( there|there)?|hello|hey|thanks|thank you|ok|okay)$/i

// 纯算式：1+1、2*3、(4+5)/2，兼容「1+1等于几」这种口语问法
const PURE_MATH = /^[\d\s+\-*/×÷().=%]+$/

/** 判断这句话是否值得联网搜索。返回 true 才真的发搜索请求。 */
export function shouldSearch(text) {
    const raw = String(text || "").replace(/\s+/g, " ").trim()
    if (!raw) return false
    // 句末标点不影响语义，先去掉再比对
    const q = raw.replace(/[!！。.？?~～、,，]+$/g, "").trim()
    if (!q) return false
    // 中文输入常带空格（"你 好"），比对短句时统一去掉
    const compact = q.replace(/\s/g, "")

    // 0. 问几点、几号这类，直接本地回答
    if (LOCAL_CLOCK.test(compact)) return false

    // 1. 明显需要外部信息：优先搜索（"总结一下今天的新闻"也要搜）
    if (TIME_SENSITIVE.test(compact)) return true

    // 2. 本地任务 / 纯算式：不搜
    if (LOCAL_TASK.test(compact)) return false
    if (PURE_MATH.test(compact.replace(/(等于几|等于多少|等于|是多少|多少|结果|几)/g, ""))) return false

    // 3. 寒暄闲聊：不搜（英文短句可能带空格，两种写法都比一次）
    if (SMALL_TALK.test(q) || SMALL_TALK.test(compact)) return false

    // 4. 很短的输入（"在吗""吃了吗"）多半是闲聊，不搜
    if (compact.length <= 4) return false

    // 5. 其余拿不准：保持搜索
    return true
}

/**
 * 解析模型「要不要联网」的判定输出。
 *
 * 模型被要求只回一行 JSON，但小模型偶尔会加解释、代码块或多余标点，
 * 所以先按 JSON 解析，失败再退回关键字匹配；两者都不成立时 ok=false，
 * 由调用方回退到本地启发式规则，不让一次坏输出把流程卡死。
 */
export function parseSearchDecision(text) {
    const raw = String(text || "").trim()
    if (!raw) return { need: false, query: "", ok: false }

    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start >= 0 && end > start) {
        try {
            const obj = JSON.parse(raw.slice(start, end + 1))
            if (obj && typeof obj === "object") {
                const need = obj.search === true ||
                    obj.need_search === true ||
                    obj.needSearch === true ||
                    String(obj.search) === "true"
                const query = String(obj.query || obj.keyword || obj.q || "").trim().slice(0, 60)
                return { need: need, query: query, ok: true }
            }
        } catch (e) {
            // 落到下面的关键字兜底
        }
    }

    const lower = raw.toLowerCase()
    if (/no[_-]?search|不需要联网|无需联网|不用联网|"search"\s*:\s*false/.test(lower)) {
        return { need: false, query: "", ok: true }
    }
    if (/need[_-]?search|需要联网|要联网|"search"\s*:\s*true/.test(lower)) {
        return { need: true, query: "", ok: true }
    }
    return { need: false, query: "", ok: false }
}

export default shouldSearch
