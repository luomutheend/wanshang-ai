import store from "./lib/store";
import { initApiKey } from "./lib/apiKeyStore";

export interface AppConfig {
    // 对话接口：builtin（内置免费） / deepseek（自己的 Key）
    apiMode: string,
    // 内置接口的模型
    builtinModel: string,
    // DeepSeek 官方模型
    deepseekModel: string,
    // 用户自己的 DeepSeek Key（内存副本，持久化在 apiKeyStore，不落 store.json）
    deepseekApiKey?: string,
    deepseekSearch: boolean,
    deepseekThinking: boolean,
    deepseekMaxTokens: number,
    deepseekAskSearch: boolean,
    deepseekBackAnim: boolean
}

/**
 * 配置层：对外只暴露 read / write / save / init。
 * 写入后立即 flush，避免设置页改完马上退出应用时丢配置。
 *
 * 启动初始化拆成两步（initConfig / initKey），由 app.ux 分阶段调用：
 * 每步之间让出一帧，避免「读配置 + 读 Key + 读会话」挤在同一次事件循环里，
 * 把启动瞬间的内存与 CPU 顶到峰值。
 */
class ConfigSystem {
    async initConfig(): Promise<void> {
        await store.init();
    }

    /**
     * DeepSeek Key 独立保存：一次 storage 读取后回填到配置，
     * 页面与 client 都能同步拿到 Key。内置模式不需要 Key。
     */
    async initKey(): Promise<void> {
        try {
            await initApiKey();
        } catch (e) {
            // 恢复失败不阻塞启动
        }
    }

    async init(): Promise<void> {
        await this.initConfig();
        await this.initKey();
    }

    read<R>(f: (cfg: Readonly<AppConfig>) => R): R {
        return store.read(f as (cfg: AppConfig) => R);
    }

    async write<R>(f: (cfg: AppConfig) => R): Promise<R> {
        const result = await store.write(f as (cfg: AppConfig) => R);
        // 写盘失败不该把异常抛到页面：设置已经改在内存里，界面要正常反馈。
        // store 内部会保留 dirty，等下一次 flush 或补读后再写。
        try {
            await store.flush();
        } catch (e) {
            // 忽略写盘异常
        }
        return result;
    }

    async save(): Promise<void> {
        try {
            await store.flush();
        } catch (e) {
            // 忽略写盘异常
        }
    }
}

export const Config = new ConfigSystem();
