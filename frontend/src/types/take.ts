import type { RevStamp } from './sync';

/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */
export interface TakeLog {
  id?: number;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号，便于按镜头阅读 */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /** 实拍张数 */
  takenFrames: number;
  /** 废帧数 */
  wastedFrames: number;
  /** 剩余张数（登记时快照） */
  remainingFrames: number;
  /** 完成百分比 0-100 */
  percent: number;
  updatedAt: number;
  /** 交接：稳定标识（同镜头 + 拍摄日期 + 设备 + 顺序号派生，天然去重） */
  syncUid: string;
  /** 交接：整行修订戳 */
  rev: RevStamp;
  /** 交接：待整理标记（找不到镜头等情况） */
  pendingTag: string | null;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  takenFrames: 0,
  wastedFrames: 0,
  remainingFrames: 0,
  percent: 0,
  updatedAt: Date.now(),
  syncUid: '',
  rev: { deviceId: '', seq: 0 },
  pendingTag: null,
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
