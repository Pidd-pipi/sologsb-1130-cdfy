/**
 * 数据访问层：所有读写都在这里收口，写入前统一脱代理。
 * 普通写路径自动补 syncUid 并按字段分组盖修订戳（设备标识 + 顺序号）；
 * 交接包导入走 syncEngine 的事务通道，他机戳记原样保留。
 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { PendingEntry } from '../types/sync';
import {
  bumpFrame,
  bumpFramePatch,
  bumpProp,
  bumpPropPatch,
  bumpShot,
  bumpShotPatch,
  bumpTake,
  stampNewFrame,
  stampNewProp,
  stampNewShot,
  stampNewTake,
} from '../utils/syncStamp';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(stampNewShot(shot)));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  const prev = await db.shots.get(id);
  if (!prev) return;
  const stamps = bumpShotPatch(prev, patch);
  await db.shots.update(id, toPlain({ ...patch, ...stamps, updatedAt: Date.now() }));
}

/** 帧序联动：只改区间/时长等派生值，不推进修订戳 */
export async function touchShotDerived(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.pending, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.pending.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  // 只有找不到镜头的孤儿帧（shotId=-1）不进原有页面；有归属的待整理行仍正常显示
  const rows = await db.frames.toArray();
  return rows.filter((f) => f.shotId !== -1);
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(stampNewFrame(frame)));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(stampNewFrame(f))));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  const prev = await db.frames.get(id);
  if (!prev) return;
  const stamps = bumpFramePatch(prev, patch);
  await db.frames.update(id, toPlain({ ...patch, ...stamps, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const prev = await db.frames.get(row.id);
      if (!prev) continue;
      const rest: Omit<FrameEntry, 'id'> = { ...row, id: undefined } as unknown as Omit<FrameEntry, 'id'>;
      const stamped = bumpFrame(prev, rest as FrameEntry);
      const { id: _skipId, syncUid: _u, rev: _r, exposureRev: _e, offsetRev: _o, ...values } = stamped;
      void _skipId;
      await db.frames.update(row.id, toPlain({ ...values, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

/**
 * 整段帧序落库（插入/删除/移动后重排）：
 * 按 syncUid 与旧行对齐做字段 diff，帧号变化不推进戳记，曝光/位移真改了才盖戳。
 */
export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(f));
  await db.transaction('rw', db.frames, async () => {
    const oldRows = await db.frames.where('shotId').equals(shotId).toArray();
    const byUid = new Map(oldRows.filter((r) => r.syncUid).map((r) => [r.syncUid, r]));
    const stamped = plain.map((row) => {
      const prev = row.syncUid ? byUid.get(row.syncUid) ?? null : null;
      return bumpFrame(prev, row);
    });
    await db.frames.where('shotId').equals(shotId).delete();
    if (stamped.length) await db.frames.bulkAdd(stamped);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  const rows = await db.props.toArray();
  return rows.filter((p) => p.shotId !== -1);
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(stampNewProp(prop)));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  const prev = await db.props.get(id);
  if (!prev) return;
  const stamps = bumpPropPatch(prev, patch);
  await db.props.update(id, toPlain({ ...patch, ...stamps, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows
    .filter((t) => t.shotId !== -1)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(stampNewTake(take)));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  const prev = await db.takes.get(id);
  if (!prev) return;
  const stamped = bumpTake(prev, { ...prev, ...patch });
  await db.takes.update(id, toPlain({ ...patch, rev: stamped.rev, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/* ---------------- pending（待整理） ---------------- */

export async function listPending(): Promise<PendingEntry[]> {
  const rows = await db.pending.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addPending(entry: PendingEntry): Promise<number> {
  return db.pending.add(toPlain(entry));
}

export async function addPendingBulk(entries: PendingEntry[]): Promise<void> {
  if (!entries.length) return;
  await db.pending.bulkAdd(entries.map((e) => toPlain(e)));
}

export async function deletePending(id: number): Promise<void> {
  await db.pending.delete(id);
}

export async function countPending(): Promise<number> {
  return db.pending.count();
}
