/**
 * 修订戳盖戳规则（纯函数）：
 * - 新建行：补 syncUid，全部修订戳记为本机当前一次改动
 * - 更新行：按字段分组 diff，只有对应字段真的变化时才推进对应戳记；
 *   任意被关注字段变化都会推进整行 rev
 * syncUid 已存在、修订戳已由他机打好的导入行走 ensureImported，不重盖。
 */
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { EMPTY_REV, type RevStamp } from '../types/sync';
import { getDevice, newSyncUid, nextSeq } from './device';

export function freshStamp(): RevStamp {
  return { deviceId: getDevice().deviceId, seq: nextSeq() };
}

function changed(prev: Record<string, unknown>, next: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => prev[k] !== next[k]);
}

/* ---------------- 帧 ---------------- */

export const FRAME_EXPOSURE_KEYS = ['shotCount', 'exposureSec', 'aperture', 'iso', 'shutterAngle', 'lighting'];
export const FRAME_OFFSET_KEYS = ['propOffsetMm'];
const FRAME_IGNORE_KEYS = ['id', 'frameNo', 'shotId', 'updatedAt', 'syncUid', 'rev', 'exposureRev', 'offsetRev', 'pendingTag'];

export function stampNewFrame(row: FrameEntry): FrameEntry {
  const stamp = freshStamp();
  return {
    ...row,
    syncUid: row.syncUid || newSyncUid(),
    rev: stamp,
    exposureRev: stamp,
    offsetRev: stamp,
    pendingTag: row.pendingTag ?? null,
  };
}

/**
 * 帧重排/批量写入后，按旧值 diff 盖戳。
 * prev 为 null（新帧）时整行盖新戳；字段没变则沿用旧戳。
 */
export function bumpFrame(prev: FrameEntry | null, next: FrameEntry): FrameEntry {
  if (!next.syncUid) next = { ...next, syncUid: newSyncUid() };
  if (!prev) {
    const stamped = stampNewFrame(next);
    return { ...stamped, syncUid: next.syncUid };
  }
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  const exposureChanged = changed(p, n, FRAME_EXPOSURE_KEYS);
  const offsetChanged = changed(p, n, FRAME_OFFSET_KEYS);
  const otherKeys = Object.keys(n).filter((k) => !FRAME_IGNORE_KEYS.includes(k) && !FRAME_EXPOSURE_KEYS.includes(k) && !FRAME_OFFSET_KEYS.includes(k));
  const anyChanged = exposureChanged || offsetChanged || changed(p, n, otherKeys);
  if (!anyChanged) {
    // 帧号重排（frameNo 变化）不推进戳记；沿用旧戳
    return {
      ...next,
      rev: prev.rev,
      exposureRev: prev.exposureRev,
      offsetRev: prev.offsetRev,
    };
  }
  const stamp = freshStamp();
  return {
    ...next,
    rev: stamp,
    exposureRev: exposureChanged ? stamp : prev.exposureRev ?? EMPTY_REV,
    offsetRev: offsetChanged ? stamp : prev.offsetRev ?? EMPTY_REV,
  };
}

/** 局部更新：返回应随 patch 一起写入的戳记字段（无字段变化时返回空对象） */
export function bumpFramePatch(prev: FrameEntry, patch: Partial<FrameEntry>): Partial<FrameEntry> {
  const candidate = { ...prev, ...patch } as FrameEntry;
  const stamped = bumpFrame(prev, candidate);
  const out: Partial<FrameEntry> = {};
  if (stamped.exposureRev !== prev.exposureRev) out.exposureRev = stamped.exposureRev;
  if (stamped.offsetRev !== prev.offsetRev) out.offsetRev = stamped.offsetRev;
  if (stamped.rev !== prev.rev) out.rev = stamped.rev;
  return out;
}

/* ---------------- 道具 ---------------- */

export const PROP_RANGE_KEYS = ['fromFrame', 'toFrame'];
export const PROP_POS_KEYS = ['posX', 'posY', 'posZ', 'rotation'];
const PROP_IGNORE_KEYS = ['id', 'updatedAt', 'syncUid', 'rev', 'rangeRev', 'posRev', 'pendingTag'];

export function stampNewProp(row: PropState): PropState {
  const stamp = freshStamp();
  return {
    ...row,
    syncUid: row.syncUid || newSyncUid(),
    rev: stamp,
    rangeRev: stamp,
    posRev: stamp,
    pendingTag: row.pendingTag ?? null,
  };
}

export function bumpProp(prev: PropState | null, next: PropState): PropState {
  if (!next.syncUid) next = { ...next, syncUid: newSyncUid() };
  if (!prev) {
    const stamped = stampNewProp(next);
    return { ...stamped, syncUid: next.syncUid };
  }
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  const rangeChanged = changed(p, n, PROP_RANGE_KEYS);
  const posChanged = changed(p, n, PROP_POS_KEYS);
  const otherKeys = Object.keys(n).filter((k) => !PROP_IGNORE_KEYS.includes(k) && !PROP_RANGE_KEYS.includes(k) && !PROP_POS_KEYS.includes(k));
  const anyChanged = rangeChanged || posChanged || changed(p, n, otherKeys);
  if (!anyChanged) {
    return { ...next, rev: prev.rev, rangeRev: prev.rangeRev, posRev: prev.posRev };
  }
  const stamp = freshStamp();
  return {
    ...next,
    rev: stamp,
    rangeRev: rangeChanged ? stamp : prev.rangeRev ?? EMPTY_REV,
    posRev: posChanged ? stamp : prev.posRev ?? EMPTY_REV,
  };
}

export function bumpPropPatch(prev: PropState, patch: Partial<PropState>): Partial<PropState> {
  const candidate = { ...prev, ...patch } as PropState;
  const stamped = bumpProp(prev, candidate);
  const out: Partial<PropState> = {};
  if (stamped.rangeRev !== prev.rangeRev) out.rangeRev = stamped.rangeRev;
  if (stamped.posRev !== prev.posRev) out.posRev = stamped.posRev;
  if (stamped.rev !== prev.rev) out.rev = stamped.rev;
  return out;
}

/* ---------------- 镜头 / 实拍 ---------------- */

const SHOT_IGNORE_KEYS = ['id', 'updatedAt', 'syncUid', 'rev', 'progressPercent'];

export function stampNewShot(row: Shot): Shot {
  return { ...row, syncUid: row.syncUid || newSyncUid(), rev: freshStamp() };
}

export function bumpShot(prev: Shot | null, next: Shot): Shot {
  if (!next.syncUid) next = { ...next, syncUid: newSyncUid() };
  if (!prev) return stampNewShot(next);
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  const keys = Object.keys(n).filter((k) => !SHOT_IGNORE_KEYS.includes(k));
  if (!changed(p, n, keys)) return { ...next, rev: prev.rev };
  return { ...next, rev: freshStamp() };
}

export function bumpShotPatch(prev: Shot, patch: Partial<Shot>): Partial<Shot> {
  const candidate = { ...prev, ...patch } as Shot;
  const stamped = bumpShot(prev, candidate);
  return stamped.rev !== prev.rev ? { rev: stamped.rev } : {};
}

export function stampNewTake(row: TakeLog): TakeLog {
  return { ...row, syncUid: row.syncUid || newSyncUid(), rev: freshStamp(), pendingTag: row.pendingTag ?? null };
}

const TAKE_IGNORE_KEYS = ['id', 'updatedAt', 'syncUid', 'rev', 'pendingTag', 'remainingFrames', 'percent'];

export function bumpTake(prev: TakeLog | null, next: TakeLog): TakeLog {
  if (!next.syncUid) next = { ...next, syncUid: newSyncUid() };
  if (!prev) return stampNewTake(next);
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  const keys = Object.keys(n).filter((k) => !TAKE_IGNORE_KEYS.includes(k));
  if (!changed(p, n, keys)) return { ...next, rev: prev.rev };
  return { ...next, rev: freshStamp() };
}

/* ---------------- 导入行规范化（不重盖他机戳） ---------------- */

export function ensureImportedShot(row: Partial<Shot>): Shot {
  return {
    ...(row as Shot),
    syncUid: typeof row.syncUid === 'string' && row.syncUid ? row.syncUid : newSyncUid(),
    rev: row.rev ?? { ...EMPTY_REV },
  };
}

export function ensureImportedFrame(row: Partial<FrameEntry>): FrameEntry {
  return {
    ...(row as FrameEntry),
    syncUid: typeof row.syncUid === 'string' && row.syncUid ? row.syncUid : newSyncUid(),
    rev: row.rev ?? { ...EMPTY_REV },
    exposureRev: row.exposureRev ?? row.rev ?? { ...EMPTY_REV },
    offsetRev: row.offsetRev ?? row.rev ?? { ...EMPTY_REV },
    pendingTag: row.pendingTag ?? null,
  };
}

export function ensureImportedProp(row: Partial<PropState>): PropState {
  return {
    ...(row as PropState),
    syncUid: typeof row.syncUid === 'string' && row.syncUid ? row.syncUid : newSyncUid(),
    rev: row.rev ?? { ...EMPTY_REV },
    rangeRev: row.rangeRev ?? row.rev ?? { ...EMPTY_REV },
    posRev: row.posRev ?? row.rev ?? { ...EMPTY_REV },
    pendingTag: row.pendingTag ?? null,
  };
}

export function ensureImportedTake(row: Partial<TakeLog>): TakeLog {
  return {
    ...(row as TakeLog),
    syncUid: typeof row.syncUid === 'string' && row.syncUid ? row.syncUid : newSyncUid(),
    rev: row.rev ?? { ...EMPTY_REV },
    pendingTag: row.pendingTag ?? null,
  };
}

/** 修订戳新旧比较：a 比 b 新返回 >0；deviceId 相同按 seq，不同设备也按 seq（同机顺序号即足够），平手返回 0 */
export function compareRev(a: RevStamp | null | undefined, b: RevStamp | null | undefined): number {
  if (!a || !a.deviceId) return b && b.deviceId ? -1 : 0;
  if (!b || !b.deviceId) return 1;
  if (a.deviceId === b.deviceId) return a.seq - b.seq;
  // 不同设备：顺序号不可直接比；用 (seq 差) 无法定时，回落到 deviceId 字典序保证确定性
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.deviceId.localeCompare(b.deviceId);
}

/** 两边修订戳是否来自不同设备且都非空（用于判定「两边都改过」的并列冲突） */
export function bothDevicesChanged(local: RevStamp | null | undefined, remote: RevStamp | null | undefined): boolean {
  return !!local?.deviceId && !!remote?.deviceId && local.deviceId !== remote.deviceId;
}
