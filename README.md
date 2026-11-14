<div align="center">

# 腕上AI

**小米 Vela 手表上的 AI 助手快应用**

不用掏手机，抬腕就能问。支持 DeepSeek 官方接口与任意 OpenAI 兼容端点，带联网搜索、深度思考、模型切换和多轮会话。

[![Platform](https://img.shields.io/badge/platform-Vela%20QuickApp-2EAA96?style=flat-square)](https://iot.mi.com/vela/quickapp/)
[![Engine](https://img.shields.io/badge/engine-QuickJS%20%2F%20JSC-2EAA96?style=flat-square)]()
[![License](https://img.shields.io/badge/license-AGPL--3.0-2EAA96?style=flat-square)](LICENSE)

</div>

## 为什么做这个

手表上能装的应用不少，能正经聊天的不多。这个项目的目标很窄：**在 466×466 的圆角方屏上，把「问一句、等一会儿、看答案」这件事做到不别扭。**

具体到实现，就是几个取舍：

- 回答不是整段蹦出来，而是分段续写 + 逐字补显，首字延迟从十几秒压到 1~2 秒
- 长会话不会一次性铺开，默认只渲染最近 20 条，上滑再按批加载
- 联网搜索的结果先摘出正文再喂给模型，而不是把十条摘要甩进去
- 退出应用不丢会话，重启后能接着上次聊

## 功能

| 能力 | 说明 |
| --- | --- |
| 两种接口模式 | **内置免费**（自定义 OpenAI 兼容端点，装好即用）/ **DeepSeek 官方**（填自己的 Key） |
| AI 设定 | 翻译官、耐心老师、程序员等 6 种预设人设，也可自写一段设定；作为 system 提示随每次提问发送 |
| 联网搜索 | 基于 DeepSeek `/v1/tools/search`，固定取 10 条正文；结果质量差时自动换角度重搜一次 |
| 深度思考 | 推理与正文共用预算，正文被挤空时自动降级补问 |
| 模型切换 | 内置模式拉 `GET /models` 动态列表；官方模式在 flash / pro 间切换 |
| 多轮会话 | 最多 12 个会话、每会话 120 条消息，落盘双备份 |
| 中文输入 | 内置九宫格 T9 输入法，含中英日词库，不依赖系统输入 |
| Token 统计 | 按会话累计 prompt / completion，可查用量趋势 |
| 余额查询 | DeepSeek 官方接口专属，`GET /user/balance` |
| 深色适配 | 界面按手表 OLED 调过，黑底不吃电，圆屏另有一套布局 |

## 适配机型

快应用有两个引擎，**包不能混装**：

| 包 | 引擎 | 适用 |
| --- | --- | --- |
| `wanshang-ai-*.rpk` | QuickJS | S1 Pro、Watch S3 / S4 / 5 / 6 等大多数机型 |
| `wanshang-ai-*-s5-jsc.rpk` | JSC（纯字节码） | 只认 JSC 的 Vela 5 机型（如 Watch S5） |

装错的表现是白屏或闪退。不确定机型就先装通用版，能起来就对了。

## 安装

1. 下载对应机型的 `.rpk`：
   - 通用版（QuickJS）：[wanshang-ai-1.2.0.rpk](release/v1.2.0/wanshang-ai-1.2.0.rpk)
   - Watch S5（JSC）：[wanshang-ai-1.2.0-s5-jsc.rpk](release/v1.2.0/wanshang-ai-1.2.0-s5-jsc.rpk)
2. 手表与手机保持连接，用小米运动健康 / Vela 调试工具推送安装
3. 首次启动进设置 → 接口，选择模式

覆盖安装不会丢数据，包名 `org.coratech.deepseek.vela` 保持不变。

## 配置

### 模式一：内置免费（默认）

需要你自己准备一把 Key 并写进包里，因为**「免填 Key」的代价是 Key 随包分发**——任何拿到安装包的人解包都能看到。

1. 在 [阿里云百炼](https://bailian.console.aliyun.com/) 申请 API Key
2. 填进 `src/deepseek/builtinKey.js`
3. `npm run release` 重新构建

想换成别的服务商，把同文件的 `BUILTIN_BASE_URL` 改掉即可：

```js
export const BUILTIN_KEY = "sk-xxxxxxxx"
export const BUILTIN_BASE_URL = "https://api.siliconflow.cn/v1"
```

支持任何 OpenAI 兼容端点（SiliconFlow、智谱、Moonshot、自建 one-api 等）。

**不填也能用**：应用会提示「内置接口未配置」，到设置里切到 DeepSeek 官方模式即可。

### 模式二：DeepSeek 官方

设置 → 接口 → DeepSeek，填自己的 Key。这个模式下才有：

- 联网搜索 `/v1/tools/search`
- 余额查询 `/user/balance`
- 深度思考

Key 存在 storage 与 `dsdata/api-key.txt` 两处互备，界面上只显示 `sk-…abcd` 掩码。

## 从源码构建

```bash
git clone https://github.com/luomutheend/wanshang-ai.git
cd wanshang-ai
npm install          # 会自动生成 src/deepseek/builtinKey.js
npm run release      # QuickJS 通用版
npm run release:s5   # JSC 版（Watch S5）
```

产物在 `dist/`。

构建需要签名证书 `sign/private.pem` 与 `sign/certificate.pem`。这两个文件**不在仓库里**——自己生成一对即可：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout sign/private.pem -out sign/certificate.pem \
  -subj "/CN=your-name"
```

同一对证书签出的包才能覆盖安装，换证书等于换了一个应用。

## 项目结构

```
src/
├── app.ux                    启动流程：配置 → Key → 会话 → 设备信息
├── pages/
│   ├── splash/               启动页（轮询等 bootDone，带跳转重试）
│   ├── index/                对话页：发送、渲染窗口、搜索状态、输入
│   ├── settings/             设置、API Key、模型列表
│   ├── history/  stats/  balance/  about/
├── deepseek/
│   ├── client.js             对话与搜索客户端，两种模式统一成同一套返回
│   └── builtinKey.js         本地 Key（.gitignore）
├── lib/
│   ├── sessions.js           会话持久化：KV + 文件双写，分批加载
│   ├── store.js              配置与统计，三态读取防覆盖
│   ├── persona.js            AI 角色设定：预设人设与自定义提示词
│   ├── apiKeyStore.js        Key 独立存取
│   └── ui.js                 页面池、GC
└── components/
    └── InputMethod/          九宫格中文输入法
```

## 在 Vela 上踩过的坑

这一节给同样要做手表 AI 客户端的人，都是实测结论。

**`system.fetch` 没有流式，也没有 abort。** 只在响应结束时回调一次，拿不到 SSE 的 `data:` 分段。所谓「逐字出现」是自己拿分段续写拼出来的——把一次回答拆成约 200 token 一段，`finish_reason === "length"` 时回填已生成内容再要求续写，页面按 45ms 一帧补显。代价是请求数变多，续写衔接处偶有措辞重复。

**storage 在启动头 1~2 秒可能不回调。** 不是返回空，是 Promise 一直挂着。如果这时按「读不到 = 没有数据」处理，接着写入默认值，就会把磁盘上的真实配置和会话覆盖掉——表现就是「退出重进丢数据，重启后又能恢复」。解法是读取做成三态（成功有值 / 成功但空 / 失败），失败时进入只读模式、保留 dirty 标记，首屏后补读一次。

**文件接口调用次数多了会触发重启。** 会话数据不要每条消息都写文件，改成防抖 + 批量。

**裸文本必须包在 `<text>` 里**，否则不渲染。这条会让人在真机上困惑很久。

**搜索与抓取全在服务端。** 手表只发几十字节 JSON、收一份 JSON，所以「取 10 条正文」不会撑爆手表内存——真正要控制的是喂给模型的上下文体量，不是网络传输。

## 已知限制

- **没有真 SSE**：如上，是分段续写模拟的。要真流式得自建中继服务
- **深度思考仍整段等待**：推理与正文共用 `max_tokens`，拆不开
- **内置 Key 随包分发**：只适合自用或小范围，公开分发请走模式二
- **未做多语言**：界面只有中文
- **真机覆盖有限**：主要在 466 设计宽度上验证，其它尺寸可能有布局溢出

## 协议

[AGPL-3.0](LICENSE)。

你可以自由使用、修改、分发，包括商用。但如果你修改后通过网络提供服务，必须同样开源。

### 第三方

| 项目 | 授权 | 说明 |
| --- | --- | --- |
| [Vela_input_method](https://github.com/NEORUAA/Vela_input_method) | MIT © 2024 NEORUAA | `src/components/InputMethod/`，本项目有裁剪与适配，原声明保留在目录内 |
| [aiot-toolkit](https://www.npmjs.com/package/aiot-toolkit) | ISC | 构建工具链 |
| [rspack](https://github.com/web-infra-dev/rspack) | MIT | 打包器 |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 类型检查 |

MIT 与 AGPL-3.0 兼容，本项目整体仍按 AGPL-3.0 分发。
