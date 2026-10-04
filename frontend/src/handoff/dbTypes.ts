/**
 * 待整理（pending）与已应用操作日志（op log）两张新表的行模型（Dexie v4 新增）。
 */
import type { HandOp } from './types';

/** 待整理原因 */
export type PendingReason =
  | 'exposure-conflict' // 同一帧曝光两边都改
  | 'prop-conflict' // 同一道具同一区间两边都改
  | 'frame-orphan' // 帧序重排后找不到落点的本机帧
  | 'prop-offrange' // 帧序变化后区间整体落在帧序之外的道具
  | 'unknown-shot' // 镜号在本机不存在
  | 'unknown-frame' // frameUid / propUid 找不到落点
  | 'unknown-prop';

export interface PendingItem {
  id?: number;
  /** 镜号（找不到镜头时也保留，便于人工认领） */
  shotCode: string;
  reason: PendingReason;
  /** 冲突 / 待整理对象的稳定标识（frameUid / propUid / takeUid） */
  refUid: string;
  /** 来源操作（系统重算类待整理可能没有对应操作，此时为空） */
  op?: HandOp;
  /** 并列保留的本机值（冲突时） */
  local?: unknown;
  /** 并列保留的对方值（来自交接包） */
  incoming?: unknown;
  /** 人类可读说明 */
  note: string;
  createdAt: number;
}

/** 已应用操作日志：按 [deviceId+seq] 去重、判缺口；本机操作带完整 op 供组包导出 */
export interface HandOpLogRow {
  id?: number;
  deviceId: string;
  seq: number;
  opType: HandOp['op'];
  shotCode: string;
  appliedAt: number;
  /** 完整操作（本机产生时一定有；导入的他机操作冗余保留，可整包转发） */
  op?: HandOp;
}
