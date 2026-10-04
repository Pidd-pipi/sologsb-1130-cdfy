/**
 * 待整理条目的解决动作：
 * - 曝光 / 道具区间冲突：可「采用本机」或「采用他机」，选定前本机数据保持不动
 * - 找不到镜头的孤儿条目：挂到选定镜头（帧自动排到帧序末尾并参与重算）
 * - 区间失效道具：改区间或直接清除待整理标记
 * - 丢弃：仅删除待整理记录，不动任何业务数据
 */
import { db, toPlain } from '../db';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { PendingEntry } from '../types/sync';
import { durationToFrames } from '../utils/frameMath';
import { raiseSeqWatermark } from '../utils/device';

const FRAME_EXPOSURE_FIELDS = [
  'shotCount',
  'exposureSec',
  'aperture',
  'iso',
  'shutterAngle',
  'lighting',
] as const;

const PROP_RANGE_FIELDS = ['fromFrame', 'toFrame'] as const;

async function recalcShot(shotId: number): Promise<void> {
  const shot = await db.shots.get(shotId);
  if (!shot) return;
  const count = Math.max(1, await db.frames.where('shotId').equals(shotId).count());
  const fps = shot.fps || 24;
  const durationSec = Math.round((count / fps) * 1000) / 1000;
  await db.shots.update(shotId, toPlain({
    durationSec,
    endFrame: shot.startFrame + count - 1,
    updatedAt: Date.now(),
  }));
  const planned = durationToFrames(durationSec, fps);
  const rows = await db.takes.where('shotId').equals(shotId).toArray();
  const taken = rows.reduce((s, r) => s + (r.takenFrames || 0), 0);
  const remaining = Math.max(0, planned - taken);
  const percent = Math.min(100, Math.round((taken / Math.max(1, planned)) * 100));
  await db.shots.update(shotId, toPlain({ progressPercent: percent }));
}

function touchWatermark(entry: PendingEntry): void {
  for (const rev of [entry.remoteRev, entry.localRev]) {
    if (rev?.deviceId) raiseSeqWatermark(rev.seq);
  }
}

/** 采用他机版本解决冲突 */
export async function resolveWithRemote(entry: PendingEntry): Promise<void> {
  if (typeof entry.id !== 'number') throw new Error('待整理条目缺少主键');
  const pendingId = entry.id;
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.pending, async () => {
    if (entry.subject === 'frame-exposure') {
      const frame = await db.frames.where('shotId').equals(entry.shotId ?? -1).toArray();
      const target = frame.find((f) => f.syncUid === entry.syncUid);
      if (!target) throw new Error('本机对应帧已不存在，无法采用他机版本');
      const remote = entry.remote as Partial<FrameEntry>;
      const patch: Partial<FrameEntry> = { updatedAt: Date.now() };
      for (const k of FRAME_EXPOSURE_FIELDS) {
        if (remote[k] !== undefined) (patch[k] as unknown) = remote[k];
      }
      if (remote.exposureRev) patch.exposureRev = remote.exposureRev;
      if (remote.rev) patch.rev = remote.rev;
      if (typeof target.id === 'number') await db.frames.update(target.id, toPlain(patch));
      touchWatermark(entry);
    } else if (entry.subject === 'prop-range') {
      const prop = await db.props.where('shotId').equals(entry.shotId ?? -1).toArray();
      const target = prop.find((p) => p.syncUid === entry.syncUid);
      if (!target) throw new Error('本机对应道具已不存在，无法采用他机版本');
      const remote = entry.remote as Partial<PropState>;
      const patch: Partial<PropState> = { updatedAt: Date.now() };
      for (const k of PROP_RANGE_FIELDS) {
        if (remote[k] !== undefined) (patch[k] as unknown) = remote[k];
      }
      if (remote.rangeRev) patch.rangeRev = remote.rangeRev;
      if (remote.rev) patch.rev = remote.rev;
      const shotId = entry.shotId ?? target.shotId;
      const frameCount = await db.frames.where('shotId').equals(shotId).count();
      patch.pendingTag = (patch.toFrame ?? target.toFrame) > frameCount ? 'frame-order-stale' : null;
      if (typeof target.id === 'number') await db.props.update(target.id, toPlain(patch));
      touchWatermark(entry);
    }
    await db.pending.delete(pendingId);
  });
}

/** 采用本机版本解决冲突：仅删除待整理记录，本机数据本来就未被改动 */
export async function resolveWithLocal(entry: PendingEntry): Promise<void> {
  if (typeof entry.id !== 'number') throw new Error('待整理条目缺少主键');
  const pendingId = entry.id;
  await db.pending.delete(pendingId);
}

/** 丢弃待整理条目（不动业务数据） */
export async function discardPending(entry: PendingEntry): Promise<void> {
  if (typeof entry.id !== 'number') throw new Error('待整理条目缺少主键');
  const pendingId = entry.id;
  await db.transaction('rw', db.frames, db.props, db.takes, db.pending, async () => {
    // 引用缺失镜头的孤儿条目挂在 shotId=-1 上，丢弃时一并删除其业务行
    if (entry.kind === 'orphan' && entry.shotId === -1) {
      if (entry.entityType === 'frame') {
        const row = (await db.frames.where('pendingTag').equals('orphan').toArray()).find((f) => f.syncUid === entry.syncUid);
        if (row && typeof row.id === 'number') await db.frames.delete(row.id);
      } else if (entry.entityType === 'prop') {
        const row = (await db.props.where('pendingTag').equals('orphan').toArray()).find((p) => p.syncUid === entry.syncUid);
        if (row && typeof row.id === 'number') await db.props.delete(row.id);
      } else if (entry.entityType === 'take') {
        const row = (await db.takes.where('pendingTag').equals('orphan').toArray()).find((t) => t.syncUid === entry.syncUid);
        if (row && typeof row.id === 'number') await db.takes.delete(row.id);
      }
    }
    await db.pending.delete(pendingId);
  });
}

/**
 * 把找不到镜头的孤儿条目挂到选定镜头：
 * - 帧：shotId 改挂，排到该镜头帧序末尾并重算镜头区间
 * - 道具/实拍：改挂 shotId 与镜号，清除待整理标记
 */
export async function attachOrphanToShot(entry: PendingEntry, shotId: number): Promise<void> {
  if (typeof entry.id !== 'number') throw new Error('待整理条目缺少主键');
  const pendingId = entry.id;
  const shot = await db.shots.get(shotId);
  if (!shot) throw new Error('目标镜头不存在');
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.pending, async () => {
    if (entry.entityType === 'frame') {
      const rows = await db.frames.where('pendingTag').equals('orphan').toArray();
      const target = rows.find((f) => f.syncUid === entry.syncUid);
      if (target && typeof target.id === 'number') {
        const count = await db.frames.where('shotId').equals(shotId).count();
        await db.frames.update(target.id, toPlain({
          shotId,
          frameNo: count + 1,
          pendingTag: null,
          updatedAt: Date.now(),
        }));
        await recalcShot(shotId);
      }
    } else if (entry.entityType === 'prop') {
      const rows = await db.props.where('pendingTag').equals('orphan').toArray();
      const target = rows.find((p) => p.syncUid === entry.syncUid);
      if (target && typeof target.id === 'number') {
        const frameCount = await db.frames.where('shotId').equals(shotId).count();
        const toFrame = Math.min(Math.max(target.toFrame, target.fromFrame), Math.max(1, frameCount));
        await db.props.update(target.id, toPlain({
          shotId,
          toFrame,
          pendingTag: toFrame < target.toFrame ? 'frame-order-stale' : null,
          updatedAt: Date.now(),
        }));
      }
    } else if (entry.entityType === 'take') {
      const rows = await db.takes.where('pendingTag').equals('orphan').toArray();
      const target = rows.find((t) => t.syncUid === entry.syncUid);
      if (target && typeof target.id === 'number') {
        await db.takes.update(target.id, toPlain({
          shotId,
          shotCode: shot.code,
          pendingTag: null,
          updatedAt: Date.now(),
        }));
        await recalcShot(shotId);
      }
    }
    await db.pending.delete(pendingId);
  });
}

/** 区间失效道具：手动改成新区间（不超过当前帧序），清除待整理标记 */
export async function fixStalePropRange(entry: PendingEntry, fromFrame: number, toFrame: number): Promise<void> {
  if (typeof entry.id !== 'number') throw new Error('待整理条目缺少主键');
  const pendingId = entry.id;
  const shotId = entry.shotId;
  if (typeof shotId !== 'number') throw new Error('条目缺少镜头归属');
  await db.transaction('rw', db.frames, db.props, db.pending, async () => {
    const rows = await db.props.where('shotId').equals(shotId).toArray();
    const target = rows.find((p) => p.syncUid === entry.syncUid);
    if (!target) throw new Error('道具记录已不存在');
    const frameCount = await db.frames.where('shotId').equals(shotId).count();
    const nextTo = Math.min(Math.max(1, Math.floor(toFrame)), Math.max(1, frameCount));
    const nextFrom = Math.min(Math.max(1, Math.floor(fromFrame)), nextTo);
    if (typeof target.id === 'number') {
      await db.props.update(target.id, toPlain({
        fromFrame: nextFrom,
        toFrame: nextTo,
        pendingTag: null,
        updatedAt: Date.now(),
      }));
    }
    // 若这条待整理同时是导入冲突/失效记录，清除其标记；冲突本体单独保留
    const remaining = await db.pending.where('syncUid').equals(entry.syncUid).toArray();
    const staleOnly = remaining.filter((p) => p.subject === 'prop-stale' && typeof p.id === 'number');
    for (const p of staleOnly) await db.pending.delete(p.id as number);
  });
}
