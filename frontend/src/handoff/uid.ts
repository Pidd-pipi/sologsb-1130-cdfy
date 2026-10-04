/**
 * 纯运行时唯一标识（不依赖 localStorage / 设备设置）。
 * 供数据模型工厂生成新行 uid；设备身份相关逻辑走 handoff/device。
 */
export function newUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const rnd = () =>
    typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
      ? crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0')
      : Math.random().toString(16).slice(2, 10);
  return `${rnd()}-${rnd()}-${rnd()}-${rnd()}`;
}
