/**
 * 交接字段（v4 升级后追加）。
 * 旧数据在 Dexie v4 upgrade 中统一补齐，因此业务代码可按「必存在」读取；
 * 对 4 个既有模型仍声明为可选，保证旧页面 / 旧对象字面量不报错。
 */

/** 改动来源：设备标识 + 本机单调顺序号（从 1 起） */
export interface ChangeOrigin {
  /** 产生该改动的设备标识 */
  deviceId: string;
  /** 该设备上的单调顺序号，从 1 开始 */
  seq: number;
}

/** 交接记录头：稳定身份、乐观版本与最后改动来源 */
export interface HandoffMeta {
  /** 跨设备稳定唯一标识（UUID），合并时的主键 */
  uid: string;
  /** 乐观版本：本机每改一次 +1；交接操作携带改动前的 baseRev */
  rev: number;
  /** 最后一次改动的设备标识与顺序号 */
  lastChange: ChangeOrigin;
}

/** 帧序（重排 / 插入 / 删除）操作后，轨迹失效重算状态 */
export type TrajectoryState = 'ok' | 'stale';
