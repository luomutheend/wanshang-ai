/**
 * 日志入口（v2）。
 *
 * 实际实现收敛到 lib/log：内存环形缓冲 + 5s 批量追加写盘。
 * 旧实现每打一条日志就触发一次 append 写文件，高频日志会显著占用 IO、
 * 是手表端卡顿甚至看门狗重启的常见诱因，这里统一改为批量落盘。
 * 页面与组件继续使用 global.logger.log/warn/error，无需改动。
 */
import logger from "../lib/log";

export default logger;
