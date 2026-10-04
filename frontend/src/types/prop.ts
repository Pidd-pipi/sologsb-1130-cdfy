import type { RevStamp } from './sync';

/** 道具固定方式 */
export type Fixation = '支架' | '磁吸' | '黏土';

export const FIXATION_OPTIONS: Fixation[] = ['支架', '磁吸', '黏土'];

/** 道具状态：某个道具在一段帧区间内的空间位置 */
export interface PropState {
  id?: number;
  /** 道具名 */
  name: string;
  /** 所属镜头 id */
  shotId: number;
  /** 适用帧区间起点 */
  fromFrame: number;
  /** 适用帧区间终点 */
  toFrame: number;
  /** 位置 X（mm） */
  posX: number;
  /** 位置 Y（mm） */
  posY: number;
  /** 位置 Z（mm） */
  posZ: number;
  /** 旋转角度（度） */
  rotation: number;
  /** 固定方式 */
  fixation: Fixation;
  updatedAt: number;
  /** 交接：稳定标识（同镜头 + 道具名的同一区间条目） */
  syncUid: string;
  /** 交接：整行修订戳 */
  rev: RevStamp;
  /** 交接：帧区间修订戳（区间两边都改过时据此并列） */
  rangeRev: RevStamp;
  /** 交接：位置/旋转修订戳 */
  posRev: RevStamp;
  /** 交接：待整理标记 */
  pendingTag: string | null;
}

export const createEmptyProp = (shotId: number): PropState => ({
  name: '',
  shotId,
  fromFrame: 1,
  toFrame: 24,
  posX: 0,
  posY: 0,
  posZ: 0,
  rotation: 0,
  fixation: '支架',
  updatedAt: Date.now(),
  syncUid: '',
  rev: { deviceId: '', seq: 0 },
  rangeRev: { deviceId: '', seq: 0 },
  posRev: { deviceId: '', seq: 0 },
  pendingTag: null,
});
