/**
 * 把 dist 里刚构建出来的 rpk 归档到 release/<版本>/。
 *
 * 三个机型共用同一个产物文件名（org.coratech.deepseek.vela.release.<ver>.rpk），
 * 连续构建时后一档会覆盖前一档，所以每构建完一档必须立刻收走。
 *
 * 用法：node scripts/collect-rpk.js <后缀>
 * 产物：release/v<versionName>/wanshang-ai-<versionName>-<后缀>.rpk
 */

const fs = require("fs")
const path = require("path")

const root = path.join(__dirname, "..")
const dist = path.join(root, "dist")
const suffix = process.argv[2]

if (!suffix) {
    console.error("用法: node scripts/collect-rpk.js <后缀>")
    process.exit(1)
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json"), "utf8"))
const version = manifest.versionName

if (!fs.existsSync(dist)) {
    console.error("dist 不存在，构建没成功")
    process.exit(1)
}

// 取最新生成的那个，避免残留的旧产物被误收
const files = fs.readdirSync(dist).filter(n => n.endsWith(".rpk"))
if (!files.length) {
    console.error("dist 里没有 rpk")
    process.exit(1)
}
const latest = files
    .map(name => ({ name, mtime: fs.statSync(path.join(dist, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].name

const outDir = path.join(root, "release", "v" + version)
fs.mkdirSync(outDir, { recursive: true })

const outName = `wanshang-ai-${version}-${suffix}.rpk`
fs.copyFileSync(path.join(dist, latest), path.join(outDir, outName))

const kb = Math.round(fs.statSync(path.join(outDir, outName)).size / 1024)
console.log(`已归档 ${outName}（${kb} KB）`)
