#!/usr/bin/env node
/**
 * 从模板生成 src/deepseek/builtinKey.js。
 *
 * 这个文件不随仓库分发（.gitignore 忽略），因为它是放 API Key 的地方。
 * 已经存在就跳过，避免覆盖你自己填好的 Key。
 */
const fs = require("fs")
const path = require("path")

const dir = path.resolve(__dirname, "../src/deepseek")
const target = path.join(dir, "builtinKey.js")
const template = path.join(dir, "builtinKey.example.js")

if (fs.existsSync(target)) {
  process.exit(0)
}

if (!fs.existsSync(template)) {
  console.warn("[setup-key] 找不到 builtinKey.example.js，跳过")
  process.exit(0)
}

fs.copyFileSync(template, target)
console.log(
  "[setup-key] 已生成 src/deepseek/builtinKey.js（Key 为空）。\n" +
  "           内置免费模式需要你自己填 Key；不填就在应用里切到 DeepSeek 官方接口。"
)
