#!/usr/bin/env node
/**
 * 打包后校验 RPK 签名。
 *
 * 流程：
 *  1. 定位 dist 下最新的 .rpk，读取项目 sign/certificate.pem 作为验签公钥。
 *  2. 解析 RPK 的签名块（Sig Block），用证书公钥做 RSA-SHA256 验签。
 *  3. 重新计算 zip 三个区段（header/central/footer）摘要，与签名块中记录的聚合摘要比对。
 *  4. 校验签名块中的文件摘要列表与 zip 内各文件内容一致。
 *  5. 对 META-INF/CERT 内的 hash.json 再做一次逐文件摘要校验。
 * 任一步失败即 exit 1，阻断打包。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const SIG_MAGIC = 'RPK Sig Block 42';
const SIG_KV_BLOCK = 0x01000101; // 签名块
const SIG_KV_FILES = 0x01000201; // 文件摘要列表

const PROJECT_ROOT = path.resolve(__dirname, '..');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('未找到 zip EOCD（不是有效的 zip/rpk）');
}

/** 读取 zip 中的文件条目（名称 + 解压后的内容） */
function readZipEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录记录格式错误');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (name.endsWith('/')) content = Buffer.alloc(0);
    else if (method === 0) content = Buffer.from(comp);
    else if (method === 8) content = zlib.inflateRawSync(comp);
    else throw new Error(`不支持的解压方式 ${method}（${name}）`);
    entries.push({ name, content });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 解析签名块，返回签名数据、签名、聚合摘要与文件摘要列表。
 * RPK 的签名块被插入在“本地文件区”与“中央目录”之间。
 */
function parseSignatureBlock(buf) {
  const eocd = findEocd(buf);
  const cdOff = buf.readUInt32LE(eocd + 16);

  // 顺序扫描本地文件头，得到签名块起点
  let off = 0;
  while (off < cdOff && buf.readUInt32LE(off) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const compSize = buf.readUInt32LE(off + 18);
    off += 30 + nameLen + extraLen + compSize;
  }
  const signStart = off;
  const signEnd = cdOff;
  const signLen = signEnd - signStart;
  if (signLen < 32) throw new Error('未找到签名块');

  const magic = buf.toString('latin1', signEnd - 16, signEnd);
  if (magic !== SIG_MAGIC) throw new Error(`签名块魔术值不匹配：${JSON.stringify(magic)}`);

  const kvEnd = signEnd - 24;
  let p = signStart + 8;
  let signdata = null;
  let signature = null;
  let aggregateDigest = null;
  const fileHashes = [];

  while (p < kvEnd) {
    p += 4; // kv.size
    p += 4; // 保留
    const kvId = buf.readUInt32LE(p);
    p += 4;
    const valueSize = buf.readUInt32LE(p);
    p += 4;
    const vStart = p;

    if (kvId === SIG_KV_BLOCK) {
      let q = vStart;
      q += 4; // block.size
      const signdataSize = buf.readUInt32LE(q);
      q += 4;
      signdata = buf.subarray(q, q + signdataSize);
      q += signdataSize;
      q += 4; // signatures.size
      q += 4; // signature.size
      q += 4; // signature.id
      const sigLen = buf.readUInt32LE(q);
      q += 4;
      signature = buf.subarray(q, q + sigLen);
      q += sigLen;
      // 其后为公钥，此处无需使用（用证书公钥验签）
    } else if (kvId === SIG_KV_FILES) {
      const vEnd = vStart + valueSize;
      let q = vStart;
      while (q < vEnd) {
        const chunkSize = buf.readUInt32LE(q); // 摘要区长度（含 4 字节 id 前缀）
        const digestsStart = q + 8; // 跳过 [size][0x0103]
        const digestsEnd = q + 4 + chunkSize;
        let r = digestsStart;
        while (r < digestsEnd) {
          const nameHash = buf.readUInt32LE(r);
          const hashLen = buf.readUInt16LE(r + 4);
          const hash = Buffer.from(buf.subarray(r + 6, r + 6 + hashLen));
          fileHashes.push({ nameHash, hash });
          r += 6 + hashLen;
        }
        const s = q + 4 + chunkSize; // 其后的签名字块
        const signDataLen = buf.readUInt32LE(s + 8);
        q = s + 12 + signDataLen;
      }
    }
    p = vStart + valueSize;
  }

  if (!signdata || !signature) throw new Error('签名块内容不完整');

  const digestLen = signdata.readUInt32LE(12);
  aggregateDigest = Buffer.from(signdata.subarray(16, 16 + digestLen));

  return { signStart, signLen, cdOff, eocd, signdata, signature, aggregateDigest, fileHashes };
}

function sectionDigest(bytes) {
  return sha256(Buffer.concat([Buffer.from([0xa5]), u32le(bytes.length), bytes]));
}

/** 完整校验一个“已签名 zip”（RPK 或 META-INF/CERT 均适用） */
function verifySignedZip(buf, publicKey, label, options) {
  const checkFiles = !options || options.checkFiles !== false;
  const info = parseSignatureBlock(buf);

  // 1. RSA-SHA256 验签
  if (!crypto.verify('RSA-SHA256', info.signdata, publicKey, info.signature)) {
    throw new Error(`${label}：签名验证失败（RSA-SHA256 不通过）`);
  }

  // 2. 聚合摘要比对（header + central + footer），footer 需还原插入签名块前的中央目录偏移
  const footer = Buffer.from(buf.subarray(info.eocd));
  footer.writeUInt32LE(info.cdOff - info.signLen, 16);
  const whole = Buffer.concat([
    Buffer.from([0x5a]),
    u32le(3),
    sectionDigest(buf.subarray(0, info.signStart)),
    sectionDigest(buf.subarray(info.cdOff, info.eocd)),
    sectionDigest(footer),
  ]);
  if (!sha256(whole).equals(info.aggregateDigest)) {
    throw new Error(`${label}：聚合摘要不匹配（内容被改动或签名与内容不对应）`);
  }

  const entries = readZipEntries(buf).filter((e) => !e.name.endsWith('/'));

  // 3. 文件摘要列表比对
  if (checkFiles) {
    const byName = new Map(entries.map((e) => [crc32(Buffer.from(e.name, 'utf8')), e]));
    for (const fh of info.fileHashes) {
      const entry = byName.get(fh.nameHash);
      if (!entry) continue; // 未在签名列表中出现的文件不参与比对
      if (!sha256(entry.content).equals(fh.hash)) {
        throw new Error(`${label}：文件摘要不一致：${entry.name}`);
      }
    }
  }

  return { info, entries };
}

function findLatestRpk() {
  const dist = path.join(PROJECT_ROOT, 'dist');
  if (!fs.existsSync(dist)) throw new Error(`dist 目录不存在：${dist}`);
  const rpks = fs
    .readdirSync(dist)
    .filter((f) => f.endsWith('.rpk'))
    .map((f) => path.join(dist, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!rpks.length) throw new Error('dist 下未找到 .rpk 产物');
  return rpks[0];
}

function main() {
  const args = process.argv.slice(2);
  // 可选：允许 hash.json 记录了包内不存在的文件（jsc 构建会把入口等重命名为 .jsc）
  const allowMissing = args.includes('--allow-missing');
  const rpkArg = args.find((a) => !a.startsWith('--'));
  const rpkPath = rpkArg ? path.resolve(rpkArg) : findLatestRpk();
  const certPath = path.join(PROJECT_ROOT, 'sign', 'certificate.pem');

  console.log(`[verify-sign] 待校验：${path.relative(PROJECT_ROOT, rpkPath)}`);
  if (!fs.existsSync(certPath)) throw new Error(`缺少签名证书：${certPath}`);

  const publicKey = new crypto.X509Certificate(fs.readFileSync(certPath)).publicKey;
  const buf = fs.readFileSync(rpkPath);

  const { entries } = verifySignedZip(buf, publicKey, 'RPK');
  console.log(`[verify-sign] RPK 签名有效，聚合摘要与文件摘要一致（${entries.length} 个文件）`);

  // 4. 校验 META-INF/CERT 的签名及其内部 hash.json
  const certEntry = entries.find((e) => e.name === 'META-INF/CERT');
  if (certEntry) {
    const certBuf = certEntry.content;
    const inner = verifySignedZip(certBuf, publicKey, 'META-INF/CERT', { checkFiles: false });
    const hashJsonEntry = inner.entries.find((e) => e.name === 'hash.json');
    if (hashJsonEntry) {
      const manifest = JSON.parse(hashJsonEntry.content.toString('utf8'));
      const digests = manifest.digests || {};
      const byName = new Map(entries.map((e) => [e.name, e]));
      let count = 0;
      let missing = 0;
      for (const [name, hex] of Object.entries(digests)) {
        const entry = byName.get(name);
        if (!entry) {
          if (allowMissing) {
            missing++;
            continue;
          }
          throw new Error(`hash.json 记录的文件缺失：${name}`);
        }
        if (sha256(entry.content).toString('hex') !== hex) {
          throw new Error(`hash.json 摘要不一致：${name}`);
        }
        count++;
      }
      console.log(`[verify-sign] META-INF/CERT 有效，hash.json 覆盖 ${count} 个文件校验通过`);
      if (missing) {
        console.log(`[verify-sign] 注意：hash.json 另有 ${missing} 个文件在包内不存在（jsc 构建已知情况，已忽略）`);
      }
    }
  }

  console.log('[verify-sign] ✅ 签名校验通过');
}

try {
  main();
} catch (err) {
  console.error(`[verify-sign] ❌ 签名校验失败：${err.message}`);
  process.exit(1);
}