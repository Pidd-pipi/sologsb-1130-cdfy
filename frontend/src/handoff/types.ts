/**
 * 拍摄交接包的操作模型与包格式。
 *
 * 合并以「操作日志（op log）」为准：每台设备对帧曝光 / 帧序 / 道具区间 / 实拍
 * 的改动各记成一条带设备标识与顺序号的操作。顺序号在单设备内从 1 起连续递增，
 * (deviceId, seq) 全局唯一，导入时据此去重、判缺口与失败重试。
 */
import type { ShotCount } from '../types/frame';
import type { Fixation } from '../types/prop';
import type { ChangeOrigin } from '../types/handoff';

export const HANDOFF_FORMAT = 'gbstopmotion-handoff';
export const HANDOFF_VERSION = 1;
/** 交接包超过该操作项数时，导入前做本机容量校验 */
export const LARGE_PACKAGE_OPS = 1000;
/** 本机默认容量（shots/frames/props/takes/pending 合计上限），可在交接页调整 */
export const DEFAULT_DEVICE_CAPACITY = 50000;

export type HandOpType = 'shot.upsert' | 'frame.exposure' | 'frame.order' | 'prop.upsert' | 'take.add';

interface BaseOp {
  op: HandOpType;
  /** 产生该操作的设备标识 */
  deviceId: string;
  /** 该设备上的单调顺序号，从 1 开始、连续递增 */
  seq: number;
  /** 操作时间戳 */
  at: number;
}

/** 镜头登记 / 参数更新（镜号为跨设备稳定键，两台机器先后给同一镜号建档时按字段并入） */
export interface ShotUpsertOp extends BaseOp {
  op: 'shot.upsert';
  /** 镜号（跨设备稳定键） */
  shotCode: string;
  sceneName: string;
  fps: number;
  durationSec: number;
  startFrame: number;
  status: string;
  owner: string;
}

/** 同一帧曝光（含逐帧位移量）分组字段；同一帧两边都改这一组时按冲突处理 */
export interface ExposurePayload {
  shotCount: ShotCount;
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
  lighting: string;
  propOffsetMm: number;
  note: string;
}

/** 改一帧的曝光参数（一台排帧挪道具、另一台登记实拍时最常见的竞争点） */
export interface FrameExposureOp extends BaseOp {
  op: 'frame.exposure';
  shotCode: string;
  /** 目标帧稳定标识 */
  frameUid: string;
  /** 改动发生时的帧号（仅展示用，落点以 frameUid 为准） */
  frameNo: number;
  /** 改动前该帧的 rev；本机 rev 更大且值不同即为两边都改 */
  baseRev: number;
  payload: ExposurePayload;
}

/** 帧序条带上一帧的最小快照，供对方补出本机缺失的新帧 */
export interface OrderedFrameSnapshot {
  uid: string;
  frame: {
    shotCount: ShotCount;
    exposureSec: number;
    aperture: number;
    iso: number;
    shutterAngle: number;
    lighting: string;
    propOffsetMm: number;
    note: string;
  };
  rev: number;
  lastChange: ChangeOrigin;
}

/**
 * 帧序变化（移动 / 插入 / 删除）：携带重排后的权威帧 uid 顺序与新帧快照。
 * 对方导入后以 uid 对位重排；多出来的本机帧并列保留为待整理，道具轨迹失效重算。
 */
export interface FrameOrderOp extends BaseOp {
  op: 'frame.order';
  shotCode: string;
  /** 重排后的权威帧 uid 顺序 */
  order: string[];
  /** 顺序中本机可能缺失的帧快照（通常是新插入的帧） */
  frames: OrderedFrameSnapshot[];
}

/** 道具区间字段 */
export interface PropPayload {
  name: string;
  fromFrame: number;
  toFrame: number;
  posX: number;
  posY: number;
  posZ: number;
  rotation: number;
  fixation: Fixation;
}

/** 登记 / 修改一条道具区间；同一道具同一区间两边都改时按冲突处理 */
export interface PropUpsertOp extends BaseOp {
  op: 'prop.upsert';
  shotCode: string;
  /** 道具区间行稳定标识 */
  propUid: string;
  baseRev: number;
  payload: PropPayload;
}

/** 登记一条实拍（张数 / 废帧按条累加，天然可并入） */
export interface TakeAddOp extends BaseOp {
  op: 'take.add';
  shotCode: string;
  /** 实拍记录稳定标识（同一条不重复累加） */
  takeUid: string;
  date: string;
  takenFrames: number;
  wastedFrames: number;
}

export type HandOp = ShotUpsertOp | FrameExposureOp | FrameOrderOp | PropUpsertOp | TakeAddOp;

/** 可粘贴的拍摄交接包 */
export interface HandoffPackage {
  format: typeof HANDOFF_FORMAT;
  version: number;
  /** 发包设备标识 */
  deviceId: string;
  /** 发包设备名（仅展示） */
  deviceName: string;
  createdAt: number;
  operations: HandOp[];
  /** 对 header（除 checksum）+ operations 的 FNV-1a 校验和，粘贴时验真 */
  checksum: string;
}

/** 导入结果（失败时抛出 HandoffError，不返回该结构） */
export interface ImportReport {
  packageDeviceId: string;
  total: number;
  applied: number;
  skipped: number;
  conflicts: number;
  unlanded: number;
  /** 帧序发生变化、轨迹已重算的镜头 */
  reshapedShots: string[];
  /** 实拍剩余张数被同步更新的镜头 */
  progressShots: string[];
}

export type HandoffErrorCode =
  | 'E_PARSE'
  | 'E_FORMAT'
  | 'E_CHECKSUM'
  | 'E_GAP'
  | 'E_CAPACITY'
  | 'E_IMPORT';

export class HandoffError extends Error {
  code: HandoffErrorCode;
  constructor(code: HandoffErrorCode, message: string) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
  }
}
