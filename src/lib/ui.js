/**
 * 页面过渡与 VM 池管理。
 *
 * 返回时先给当前页的 scroll 加 scroll-backanim，等动画播完再 router.back，
 * 并给上一页加上入场回退动画，避免"点返回直接硬切"。
 *
 * 注意：vmPool 必须在页面 onInit 里用 InitPage(this, "pages/xxx") 注册，
 * 否则 onBackPress 拿不到当前页实例，只能直接 router.back()——动画就"消失"了。
 */

import router from "@system.router"

let gcTimer = null

// 同一次返回可能被手势和系统返回同时触发，短时去重避免连退两页
const BACK_DEBOUNCE_MS = 500
// 退出动画时长，与 global.less 里 backpage-scroll 的 500ms 对齐
const BACK_ANIM_MS = 500

export function init() {
    global.vmPool = {}
    global.currentPageName = ""
    if (gcTimer) clearInterval(gcTimer)
    gcTimer = setInterval(runGC, 10000)
}

function clearGc() {
    if (gcTimer) {
        clearInterval(gcTimer)
        gcTimer = null
    }
}

export function stop() {
    clearGc()
    releasePool(global.vmPool)
    global.vmPool = {}
}

/**
 * 页面实例出栈时主动松掉它握着的大数组。
 *
 * 光 delete vmPool[name] 只是断开了池子里的引用，页面对象本身可能还被
 * 路由栈/动画闭包挂着；而 messages / sessions 这些数组是手表上最占内存的东西。
 * 先清空内容（length = 0 保留数组本体，避免别处还拿着同一个引用时报错），
 * 剩下的空壳随它什么时候被回收。
 */
function releaseVm(vm) {
    if (!vm) return
    try {
        if (Array.isArray(vm.messages)) vm.messages.length = 0
        if (Array.isArray(vm.history)) vm.history.length = 0
        if (Array.isArray(vm.sessions)) vm.sessions.length = 0
        if (typeof vm.pendingText === "string") vm.pendingText = ""
    } catch (e) {
        // 单个字段清理失败不影响主流程
    }
}

function releasePool(pool) {
    if (!pool) return
    for (const name in pool) releaseVm(pool[name])
}

/** 退到后台：只停定时器，保留 vmPool（否则回前台返回动画就失效了） */
export function pause() {
    clearGc()
}

/** 回到前台：定时器没跑就重新起一个 */
export function resume() {
    if (gcTimer) return
    gcTimer = setInterval(runGC, 10000)
}

/**
 * 注册页面实例。name 建议显式传页面路径：
 * onInit 阶段 router.getState() 在部分固件上还停留在上一页，靠它推断会注册错 key。
 */
export function initPage(vm, name) {
    let pageName = name
    if (!pageName) {
        try {
            pageName = router.getState().name
        } catch (e) {
            pageName = ""
        }
    }
    if (!pageName || !vm) return
    if (!global.vmPool) global.vmPool = {}
    global.currentPageName = pageName
    global.vmPool[pageName] = vm
}

/** 动画开关：设置里关掉后一律直接返回 */
function animEnabled() {
    try {
        return !global.config || global.config.read(c => c.deepseekBackAnim) !== false
    } catch (e) {
        return true
    }
}

function setScrClass(name, value) {
    if (name && global.vmPool && global.vmPool[name]) {
        global.vmPool[name].scrclass = value
    }
}

export function onBackPress() {
    const now = Date.now()
    if (now - (global.__lastBackAt || 0) < BACK_DEBOUNCE_MS) {
        return
    }
    global.__lastBackAt = now

    if (!animEnabled()) {
        router.back()
        return
    }

    const pages = router.getPages()
    const current = pages.length ? pages[pages.length - 1].name : null
    const previous = pages.length >= 2 ? pages[pages.length - 2].name : null
    if (!global.vmPool) global.vmPool = {}

    const currentVm = current ? global.vmPool[current] : null
    if (currentVm) {
        currentVm.scrclass = "scroll-backanim"
        setTimeout(() => {
            // 这里绝对不要写 scrclass = ""：.scroll 自带 openpage-scroll，
            // class 回落会让它重新播一遍，视觉上就是「返回动画播了两次」。
            // 用 finished（带 animation-name: none + 隐藏）收尾。
            if (global.vmPool[current]) {
                global.vmPool[current].scrclass = "scroll-backanim-finished"
            }
            router.back()
            setScrClass(previous, "scroll-frombackanim")
            // 同理，入场动画播完落到 scroll-anim-done，而不是清空
            setTimeout(() => setScrClass(previous, "scroll-anim-done"), BACK_ANIM_MS + 40)
        }, 150)
        return
    }

    // 没有注册页面实例（老页面/异常路径）：至少把上一页的入场动画播了
    router.back()
    setScrClass(previous, "scroll-frombackanim")
    setTimeout(() => setScrClass(previous, "scroll-anim-done"), BACK_ANIM_MS + 40)
}

function runGC() {
    // 只清「已经不在页面栈里」的实例。
    // 之前用 vm.$valid 判断，但 Vela 的页面对象并没有这个属性，
    // 结果每 10 秒就把整个 vmPool 清空——返回动画过一会儿就"消失"了。
    let pages = []
    try {
        pages = (router.getPages && router.getPages()) || []
    } catch (e) {
        return // 拿不到栈信息就这轮不清理，宁可留一点内存也别清错
    }
    // 空数组可能是刚启动/页面切换的瞬间，这时候清会把马上要用的实例删掉
    if (!pages.length) return
    const alive = {}
    for (let i = 0; i < pages.length; i++) {
        const item = pages[i] || {}
        if (item.name) alive[item.name] = true
    }
    for (const name in global.vmPool) {
        if (!alive[name]) {
            releaseVm(global.vmPool[name])
            delete global.vmPool[name]
        }
    }
}

/**
 * 兼容导出：app.ux 与各页面统一用大驼峰调用（ui.Init / global.ui.InitPage）。
 * 这里以前只有小写导出，导致 ui.Init 是 undefined、页面实例从未注册进 vmPool，
 * 返回动画和 10 秒一次的页面回收其实一直没跑起来。
 */
export const Init = init
export const Stop = stop
export const Pause = pause
export const Resume = resume
export const InitPage = initPage
export const OnBackPressTriggered = onBackPress
