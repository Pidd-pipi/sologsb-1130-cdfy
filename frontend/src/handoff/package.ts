/**
 * 交接包的粘贴格式与校验。
 * 粘贴文本固定带首尾标记，正文是 JSON；checksum 为 header(除 checksum) + operations
 * 的 FNV-1a 32 位十六进制，用来在粘贴 / 传输截断时拒绝坏包。
 */
import {
  HANDOFF_FORMAT,
  HANDOFF_VERSION,
  HandoffError,
  type HandOp,
  type HandoffPackage,
} from './types';

export const PACKAGE_BEGIN = '-----BEGIN GBSTOPMOTION HANDOFF-----';
export const PACKAGE_END = '-----END GBSTOPMOTION HANDOFF-----';

/** FNV-1a 32 位哈希（十六进制） */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 32 位 FNV 质数，用无符号乘并取模模拟
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 计算包校验和（与 checksum 字段本身无关） */
export function computeChecksum(pkg: Omit<HandoffPackage, 'checksum'>): string {
  const { deviceId, deviceName, createdAt, version, format, operations } = pkg;
  return fnv1a(JSON.stringify({ format, version, deviceId, deviceName, createdAt, operations }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const OP_TYPES = new Set(['shot.upsert', 'frame.exposure', 'frame.order', 'prop.upsert', 'take.add']);

/** 结构校验：只认字段形状，不改任何数据 */
export function validatePackageShape(raw: unknown): HandoffPackage {
  if (!isRecord(raw)) throw new HandoffError('E_FORMAT', '交接包不是合法对象');
  if (raw.format !== HANDOFF_FORMAT) throw new HandoffError('E_FORMAT', '交接包格式标识不正确');
  if (raw.version !== HANDOFF_VERSION) throw new HandoffError('E_FORMAT', `不支持的交接包版本：${String(raw.version)}`);
  if (typeof raw.deviceId !== 'string' || !raw.deviceId) throw new HandoffError('E_FORMAT', '缺少发包设备标识');
  if (typeof raw.createdAt !== 'number') throw new HandoffError('E_FORMAT', '缺少发包时间');
  if (!Array.isArray(raw.operations)) throw new HandoffError('E_FORMAT', '交接包 operations 不是数组');
  if (typeof raw.checksum !== 'string') throw new HandoffError('E_FORMAT', '缺少校验和');

  raw.operations.forEach((op, idx) => {
    const where = `第 ${idx + 1} 项`;
    if (!isRecord(op)) throw new HandoffError('E_FORMAT', `${where}：不是对象`);
    if (typeof op.op !== 'string' || !OP_TYPES.has(op.op)) throw new HandoffError('E_FORMAT', `${where}：未知操作类型`);
    if (typeof op.deviceId !== 'string' || !op.deviceId) throw new HandoffError('E_FORMAT', `${where}：缺少设备标识`);
    if (typeof op.seq !== 'number' || op.seq < 1 || !Number.isInteger(op.seq)) {
      throw new HandoffError('E_FORMAT', `${where}：顺序号非法`);
    }
    if (typeof op.at !== 'number') throw new HandoffError('E_FORMAT', `${where}：缺少时间戳`);
    if (typeof op.shotCode !== 'string' || !op.shotCode) throw new HandoffError('E_FORMAT', `${where}：缺少镜号`);
  });

  const expected = computeChecksum(raw as unknown as Omit<HandoffPackage, 'checksum'>);
  if (expected !== raw.checksum) {
    throw new HandoffError('E_CHECKSUM', '交接包校验和不一致，内容可能已损坏或被截断，请重新复制');
  }
  return raw as unknown as HandoffPackage;
}

/** 序列化成可粘贴文本 */
export function encodePackage(pkg: HandoffPackage): string {
  const json = JSON.stringify(pkg);
  return `${PACKAGE_BEGIN}\n${json}\n${PACKAGE_END}`;
}

/** 从粘贴文本中提取包（允许前后带聊天软件的说明文字，取首尾标记之间的内容） */
export function decodePackage(text: string): HandoffPackage {
  if (typeof text !== 'string' || !text.trim()) {
    throw new HandoffError('E_PARSE', '粘贴内容为空');
  }
  const begin = text.indexOf(PACKAGE_BEGIN);
  const end = text.lastIndexOf(PACKAGE_END);
  const body = begin >= 0 && end > begin ? text.slice(begin + PACKAGE_BEGIN.length, end).trim() : text.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new HandoffError('E_PARSE', '交接包不是合法 JSON，请完整复制（含首尾标记）后重试');
  }
  return validatePackageShape(raw);
}

/** 操作应用阶段：镜头建档 → 帧序 → 其余 */
function opPhase(op: HandOp): number {
  if (op.op === 'shot.upsert') return 0;
  if (op.op === 'frame.order') return 1;
  return 2;
}

/** 组包（按 设备 → 应用阶段 → 顺序号 排列，保证对方导入顺序确定） */
export function buildPackage(deviceId: string, deviceName: string, operations: HandOp[]): HandoffPackage {
  const sorted = operations.slice().sort((a, b) => {
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    const pa = opPhase(a);
    const pb = opPhase(b);
    if (pa !== pb) return pa - pb;
    return a.seq - b.seq;
  });
  const head: Omit<HandoffPackage, 'checksum'> = {
    format: HANDOFF_FORMAT,
    version: HANDOFF_VERSION,
    deviceId,
    deviceName,
    createdAt: Date.now(),
    operations: sorted,
  };
  return { ...head, checksum: computeChecksum(head) };
}
