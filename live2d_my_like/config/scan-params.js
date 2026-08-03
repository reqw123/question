'use strict';
// 掃描 .moc3 檔案裡內嵌的參數 ID 字串（不用開瀏覽器，純讀二進位檔案）
//
// 總體查詢（列出全部參數 ID）：
//   node live2d_my_like/config/scan-params.js <moc3 檔案路徑>
//   範例：node live2d_my_like/config/scan-params.js live2d_my_like/models/1009109/1009109.moc3
//
// 單一查詢（只問某個參數 ID 存不存在）：
//   node live2d_my_like/config/scan-params.js <moc3 檔案路徑> <參數 ID>
//   範例：node live2d_my_like/config/scan-params.js live2d_my_like/models/076/c_7001.moc3 PARAM_ARM_L_ROTATE

const fs = require('fs');

const target = process.argv[2];
const query  = process.argv[3];
if (!target) {
  console.error('用法: node scan-params.js <moc3 檔案路徑> [要查的參數 ID]');
  console.error('總體查詢: node live2d_my_like/config/scan-params.js live2d_my_like/models/076/c_7001.moc3');
  console.error('單一查詢: node live2d_my_like/config/scan-params.js live2d_my_like/models/076/c_7001.moc3 PARAM_ARM_L_ROTATE');
  process.exit(1);
}

const buf = fs.readFileSync(target);
const ids = new Set(
  (buf.toString('latin1').match(/[ -~]{4,}/g) || [])
    .filter(s => /^PARAM_|^Param/.test(s))
);

if (query) {
  console.log(`${target}`);
  console.log(`${query} → ${ids.has(query) ? '✅ 存在' : '❌ 不存在'}`);
} else {
  console.log(`${target} 共 ${ids.size} 個參數 ID：`);
  console.log([...ids].sort());
}
