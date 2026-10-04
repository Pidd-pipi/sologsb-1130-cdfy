/**
 * 本机设备标识与顺序号：
 * - 首次打开时生成随机设备标识与默认设备名，存 localStorage
 * - 顺序号单调递增，每产生一次本地改动 +1
 * 两台离线机器各有自己的标识，回到网络合并时用「标识 + 顺序号」
 * 判断改动的来源与新旧。
 */

const DEVICE_KEY = 'gbstopmotion:device';
const NAME_KEY = 'gbstopmotion:device-name';
const SEQ_KEY = 'gbstopmotion:device-seq';

/** 浏览器外（单元测试等）的内存回退存储 */
const memoryStore = new Map<string, string>();

interface MiniStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const storage: MiniStorage =
  typeof localStorage !== 'undefined'
    ? localStorage
    : {
        getItem: (k: string) => memoryStore.get(k) ?? null,
        setItem: (k: string, v: string) => void memoryStore.set(k, String(v)),
        removeItem: (k: string) => void memoryStore.delete(k),
      };

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

function randomId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `dev-${time}-${rand}`;
}

function defaultName(id: string): string {
  const tail = id.replace(/[^a-z0-9]/g, '').slice(-4).toUpperCase();
  return `拍摄机 ${tail || 'A'}`;
}

export function getDevice(): DeviceIdentity {
  let deviceId = storage.getItem(DEVICE_KEY);
  if (!deviceId) {
    deviceId = randomId();
    storage.setItem(DEVICE_KEY, deviceId);
  }
  let deviceName = storage.getItem(NAME_KEY);
  if (!deviceName) {
    deviceName = defaultName(deviceId);
    storage.setItem(NAME_KEY, deviceName);
  }
  return { deviceId, deviceName };
}

export function setDeviceName(name: string): void {
  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) return;
  storage.setItem(NAME_KEY, trimmed);
}

/** 取当前顺序号（不递增） */
export function currentSeq(): number {
  const raw = Number(storage.getItem(SEQ_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 分配下一个顺序号 */
export function nextSeq(): number {
  const value = currentSeq() + 1;
  storage.setItem(SEQ_KEY, String(value));
  return value;
}

/** 从他机修订戳回灌时，若他机顺序号更大则把本机水位抬高，避免回绕 */
export function raiseSeqWatermark(seq: number): void {
  if (Number.isFinite(seq) && seq > currentSeq()) {
    storage.setItem(SEQ_KEY, String(Math.floor(seq)));
  }
}

/** 生成新的稳定标识（行级 syncUid） */
export function newSyncUid(): string {
  const { deviceId } = getDevice();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${deviceId}-${Date.now().toString(36)}-${rand}`;
}

/** 测试专用：重置为指定设备标识与顺序号水位（浏览器生产代码不调用） */
export function __resetDeviceForTest(deviceId: string, deviceName = '', seq = 0): void {
  storage.removeItem(DEVICE_KEY);
  storage.removeItem(NAME_KEY);
  storage.removeItem(SEQ_KEY);
  if (deviceId) {
    storage.setItem(DEVICE_KEY, deviceId);
    storage.setItem(NAME_KEY, deviceName || defaultName(deviceId));
    storage.setItem(SEQ_KEY, String(seq));
  }
}
