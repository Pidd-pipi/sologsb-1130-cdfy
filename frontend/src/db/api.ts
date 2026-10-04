/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { HandOpLogRow, PendingItem } from '../handoff/dbTypes';
import type { HandOp } from '../handoff/types';

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
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(f));
  await db.transaction('rw', db.frames, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/* ---------------- handoff：已应用操作日志 ---------------- */

/** 已应用操作的 (deviceId, seq) 键集合，导入去重 / 缺口检查用 */
export async function loadAppliedKeys(): Promise<Set<string>> {
  const list = await db.handoffOps.toArray();
  return new Set(list.map((r) => `${r.deviceId} ${r.seq}`));
}

export async function addOpLog(rows: HandOpLogRow[]): Promise<void> {
  if (!rows.length) return;
  await db.handoffOps.bulkAdd(rows.map((r) => toPlain(r)));
}

/* ---------------- handoff：待整理 ---------------- */

export async function listPending(): Promise<PendingItem[]> {
  const rows = await db.pending.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addPending(items: PendingItem[]): Promise<void> {
  if (!items.length) return;
  await db.pending.bulkAdd(items.map((i) => toPlain(i)));
}

export async function deletePending(id: number): Promise<void> {
  await db.pending.delete(id);
}

export async function countPending(): Promise<number> {
  return db.pending.count();
}

/** 当前本机全部业务表 + 待整理的行数（容量校验用） */
export async function totalRecordCount(): Promise<number> {
  const [shots, frames, props, takes, pending] = await Promise.all([
    db.shots.count(),
    db.frames.count(),
    db.props.count(),
    db.takes.count(),
    db.pending.count(),
  ]);
  return shots + frames + props + takes + pending;
}

/** 本机 / 全部已记录的交接操作（含完整 op，供组包导出与整包转发） */
export async function listOps(deviceId?: string): Promise<HandOp[]> {
  const rows = deviceId
    ? await db.handoffOps.where('deviceId').equals(deviceId).toArray()
    : await db.handoffOps.toArray();
  return rows
    .filter((r): r is HandOpLogRow & { op: HandOp } => typeof r.op === 'object' && r.op !== null)
    .map((r) => r.op)
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.seq - b.seq));
}

/** 操作日志水位（每设备最大已记录顺序号） */
export async function listOpLog(): Promise<HandOpLogRow[]> {
  return db.handoffOps.toArray();
}
