/**
 * 本机设备标识与顺序号（离线环境下用 localStorage 维护，IndexedDB 只存数据）。
 * 设备标识可由摄影助理改名；每产生一条本机交接操作，顺序号 +1。
 */
import { DEFAULT_DEVICE_CAPACITY } from './types';
import { newUid } from './uid';

const DEVICE_KEY = 'gbstopmotion:device';
const NAME_KEY = 'gbstopmotion:device-name';
const SEQ_KEY = 'gbstopmotion:device-seq';
const CAPACITY_KEY = 'gbstopmotion:device-capacity';

export { newUid };

/** localStorage 不可用（隐私模式 / 非浏览器测试环境）时的会话内回退 */
const memStore: Record<string, string> = {};

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memStore[key] ?? null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memStore[key] = value;
  }
}

function suggestName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '';
  const tag = /Mac/i.test(ua) ? 'Mac' : /Win/i.test(ua) ? 'Win' : '工位';
  return `拍摄${tag}-${newUid().slice(0, 4)}`;
}

/** 本机设备标识（首次使用时生成，持久化） */
export function getDeviceId(): string {
  let id = read(DEVICE_KEY);
  if (!id) {
    id = `dev-${newUid()}`;
    write(DEVICE_KEY, id);
  }
  return id;
}

/** 测试 / 换机初始化：清空本机设备状态（不影响 IndexedDB 业务数据） */
export function resetDeviceState(): void {
  delete memStore[DEVICE_KEY];
  delete memStore[NAME_KEY];
  delete memStore[SEQ_KEY];
  delete memStore[CAPACITY_KEY];
  try {
    window.localStorage.removeItem(DEVICE_KEY);
    window.localStorage.removeItem(NAME_KEY);
    window.localStorage.removeItem(SEQ_KEY);
    window.localStorage.removeItem(CAPACITY_KEY);
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/** 本机设备名（仅交接包展示用） */
export function getDeviceName(): string {
  let name = read(NAME_KEY);
  if (!name) {
    name = suggestName();
    write(NAME_KEY, name);
  }
  return name;
}

export function setDeviceName(name: string): string {
  const trimmed = name.trim() || getDeviceName();
  write(NAME_KEY, trimmed);
  return trimmed;
}

/** 已用掉的最大本机顺序号（未产生任何操作时为 0） */
export function getDeviceSeq(): number {
  const raw = read(SEQ_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 领取下一个本机顺序号 */
export function nextDeviceSeq(): number {
  const n = getDeviceSeq() + 1;
  write(SEQ_KEY, String(n));
  return n;
}

/** 本机容量上限（用于超过 1000 项交接包的导入校验） */
export function getDeviceCapacity(): number {
  const raw = read(CAPACITY_KEY);
  const n = raw ? Number(raw) : DEFAULT_DEVICE_CAPACITY;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DEVICE_CAPACITY;
}

export function setDeviceCapacity(value: number): number {
  const n = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DEVICE_CAPACITY;
  write(CAPACITY_KEY, String(n));
  return n;
}
