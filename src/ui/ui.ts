/**
 * 页面过渡与 VM 池（名称适配层）。
 * 保持 global.ui.Init / InitPage / OnBackPressTriggered / Stop 四个调用点，
 * 并新增 Pause / Resume：应用退后台时停掉 GC 定时器，回前台再恢复。
 */
import * as lifecycle from "../lib/ui"

export const Init = lifecycle.init
export const InitPage = lifecycle.initPage
export const OnBackPressTriggered = lifecycle.onBackPress
export const Stop = lifecycle.stop
export const Pause = lifecycle.pause
export const Resume = lifecycle.resume
