const path = require('path');
const childProcess = require('child_process');
const os = require('os');
const fs = require('fs');

// 注入buildinfo
let gitCommitHash = "unknown";
try {
    gitCommitHash = childProcess.execSync('git rev-parse HEAD').toString().trim();
} catch (e) {
    // 非 git 环境（如独立目录/CI 打包）下退化为 unknown，不影响构建
    console.warn('[quickapp.config] git rev-parse 失败，buildinfo 中的 commit 记为 unknown');
}
const username = os.userInfo().username;
const buildTime = new Date().toISOString();
const designWidth = JSON.parse(fs.readFileSync("src/manifest.json")).config.designWidth

// 构建目标机型。设置 WANSHANG_TARGET=s5esim 后，界面参数按该机型写死，
// 不再依赖运行时 device.getInfo() 的探测结果；auto 仅作兜底。
const buildTarget = String(process.env.WANSHANG_TARGET || "auto").trim().toLowerCase();

const buildInfoContent = `
  export const GIT_COMMIT_HASH = "${gitCommitHash}";
  export const BUILD_TIME = "${buildTime}";
  export const BUILD_USER = "${username}";
  export const DESIGN_WIDTH = "${designWidth}";
  export const BUILD_TARGET = "${buildTarget}";
`;

const buildInfoPath = path.resolve(__dirname, 'src/buildinfo.ts');
fs.writeFileSync(buildInfoPath, buildInfoContent, 'utf8');

module.exports = {
    // 在toolkit2.0以及更高版本，这实际上是对rspack的配置
    webpack: {
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    exclude: [/node_modules/],
                    // 因为这实际上是针对rspack的配置，所以可以使用builtin:swc-loader
                    // 使用该loader可以大幅度提升typescript转换效率
                    loader: 'builtin:swc-loader',
                    options: {
                        jsc: {
                            parser: {
                                syntax: 'typescript',
                            },
                        },
                    },
                    type: 'javascript/auto',
                }
            ]
        },
        resolve: {
            alias: {
                '@src': path.resolve(__dirname, 'src'),
                '@components': path.resolve(__dirname, 'src/components'),
                '@less': path.resolve(__dirname, 'src/less'),
                '@protobuf': path.resolve(__dirname, 'src/protobuf'),
                '$buildinfo': buildInfoPath
            }
        }
    },
    cli: {
        "enable-custom-component": true,
        "enable-jsc": true,
        "enable-protobuf": true
    }
};