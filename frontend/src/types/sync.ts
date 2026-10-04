/**
 * 双机离线交接用到的同步元数据。
 * 每条记录带稳定标识 syncUid 与修订戳（设备标识 + 该机顺序号），
 * 冲突并列、增量去重都以修订戳为准。
 */

/** 修订戳：某字段最后一次改动来自哪台设备的第几个顺序号 */
export interface RevStamp {
  /** 设备标识（持久化在本机 localStorage，换机不重合） */
  deviceId: string;
  /** 该机单调递增的顺序号，越大越新 */
  seq: number;
}

export const EMPTY_REV: RevStamp = { deviceId: '', seq: 0 };

export function isEmptyRev(rev: RevStamp | undefined | null): boolean {
  return !rev || !rev.deviceId || rev.seq <= 0;
}

/** 待整理条目类型 */
export type PendingKind = 'conflict' | 'orphan';
export type PendingEntityType = 'frame' | 'prop' | 'take';

/**
 * 待整理条目：
 * - conflict：同一帧曝光 / 同一道具帧区间两边都改过，并列保留等待选定
 * - orphan：找不到落点的他机条目（镜号对不上、帧序引用缺失等）
 */
export interface PendingEntry {
  id?: number;
  kind: PendingKind;
  entityType: PendingEntityType;
  /** 冲突焦点说明（如「第 012 帧曝光参数」「道具「小车」帧区间」） */
  title: string;
  /** 焦点字段：exposure / propRange */
  subject: string;
  /** 本机镜头 id；孤儿条目尚未找到落点时为 null */
  shotId: number | null;
  shotCode: string;
  /** 条目稳定标识（他机 syncUid；残缺条目用派生标识） */
  syncUid: string;
  /** 本机行快照（去掉本地主键），无本机行时为 null */
  local: Record<string, unknown> | null;
  /** 他机行快照（去掉本地主键） */
  remote: Record<string, unknown>;
  /** 他机来源设备标识/名称 */
  remoteDeviceId: string;
  remoteDeviceName: string;
  /** 他机条目的焦点修订戳 */
  remoteRev: RevStamp;
  /** 本机条目的焦点修订戳 */
  localRev: RevStamp | null;
  /** 孤儿条目所属的他机镜头摘要，供并入时选镜头 */
  remoteShot: {
    syncUid: string;
    code: string;
    sceneName: string;
    fps: number;
    durationSec: number;
    startFrame: number;
    status: string;
    owner: string;
  } | null;
  /** 进入待整理的原因说明 */
  detail: string;
  createdAt: number;
}

/* ---------------- 交接包 ---------------- */

export const HANDOVER_FORMAT = 'gbstopmotion-handover';
export const HANDOVER_VERSION = 1;
/** 交接包条目数阈值：超过后先做本机容量预检，容量不足拒绝导入 */
export const HANDOVER_ITEM_LIMIT = 1000;

export interface HandoverShot {
  syncUid: string;
  code: string;
  sceneName: string;
  fps: number;
  durationSec: number;
  startFrame: number;
  endFrame: number;
  status: string;
  owner: string;
  progressPercent: number;
  createdAt: number;
  updatedAt: number;
  rev: RevStamp;
}

export interface HandoverFrame {
  syncUid: string;
  shotSyncUid: string;
  frameNo: number;
  shotCount: number;
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
  lighting: string;
  propOffsetMm: number;
  note: string;
  updatedAt: number;
  rev: RevStamp;
  exposureRev: RevStamp;
  offsetRev: RevStamp;
  pendingTag: string | null;
}

export interface HandoverProp {
  syncUid: string;
  shotSyncUid: string;
  name: string;
  fromFrame: number;
  toFrame: number;
  posX: number;
  posY: number;
  posZ: number;
  rotation: number;
  fixation: string;
  updatedAt: number;
  rev: RevStamp;
  rangeRev: RevStamp;
  posRev: RevStamp;
  pendingTag: string | null;
}

export interface HandoverTake {
  syncUid: string;
  shotSyncUid: string;
  date: string;
  shotCode: string;
  takenFrames: number;
  wastedFrames: number;
  remainingFrames: number;
  percent: number;
  updatedAt: number;
  rev: RevStamp;
  pendingTag: string | null;
}

/** 可粘贴拍摄交接包：纯 JSON 文本，全量快照 + 每条修订戳，重复交换按戳去重 */
export interface HandoverPackage {
  format: typeof HANDOVER_FORMAT;
  version: number;
  deviceId: string;
  deviceName: string;
  exportedAt: number;
  shots: HandoverShot[];
  frames: HandoverFrame[];
  props: HandoverProp[];
  takes: HandoverTake[];
}

export interface MergeCounters {
  shots: number;
  frames: number;
  props: number;
  takes: number;
}

export interface MergeReport {
  ok: boolean;
  reason?: 'capacity' | 'invalid' | 'unknown';
  message?: string;
  imported: MergeCounters;
  updated: MergeCounters;
  skipped: MergeCounters;
  /** 并列保留的冲突数 */
  conflicts: number;
  /** 找不到落点的条目数 */
  orphans: number;
  /** 待整理总数（含历史未处理） */
  pendingTotal: number;
  /** 帧序发生变化的镜号（道具轨迹需重算、实拍剩余张数已同步） */
  frameOrderChanged: string[];
  /** 来源设备 */
  fromDevice: string;
  itemCount: number;
}

export const emptyMergeReport = (): MergeReport => ({
  ok: false,
  imported: { shots: 0, frames: 0, props: 0, takes: 0 },
  updated: { shots: 0, frames: 0, props: 0, takes: 0 },
  skipped: { shots: 0, frames: 0, props: 0, takes: 0 },
  conflicts: 0,
  orphans: 0,
  pendingTotal: 0,
  frameOrderChanged: [],
  fromDevice: '',
  itemCount: 0,
});
