'use strict';

// 共用 Fisher-Yates 洗牌，single/ 與 multi/ 都透過 ../lib 共用這份實作
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
