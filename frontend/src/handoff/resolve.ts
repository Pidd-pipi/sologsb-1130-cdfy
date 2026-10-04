/**
 * 待整理（pending）的人工处理。
 * 冲突并列项在用户选定前本机数据不动；选定后以一次普通本机编辑落库
 * （产生新的 rev 与本机交接操作，回传给对方时不再冲突），并删除待整理项。
 */
import { db, toPlain } from '../db';
import { editFrameExposure, updatePropTracked } from './local';
import type { FrameEntry } from '../types/frame';
import type { PendingItem } from './dbTypes';
import type { ExposurePayload, PropPayload } from './types';

export type ResolutionChoice = 'local' | 'incoming' | 'ignore';

/** 列出全部待整理（按时间倒序） */
export async function listPending(): Promise<PendingItem[]> {
  const rows = await db.pending.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** 找不到落点的帧 / 道具 / 实拍：忽略该条（仅删除待整理，不改业务数据） */
export async function ignorePending(id: number): Promise<void> {
  await db.pending.delete(id);
}

/** 处理一帧曝光冲突 */
export async function resolveExposureConflict(item: PendingItem, choice: ResolutionChoice): Promise<void> {
  if (typeof item.id !== 'number') return;
  if (choice === 'ignore') {
    await db.pending.delete(item.id);
    return;
  }
  if (choice === 'local') {
    // 选定本机值：不改本机数据，仅清掉待整理
    await db.pending.delete(item.id);
    return;
  }
  const frame = await db.frames.where('uid').equals(item.refUid).first();
  if (!frame) {
    await db.pending.delete(item.id);
    return;
  }
  const payload = item.incoming as ExposurePayload;
  await editFrameExposure(item.shotCode, frame, payload);
  await db.pending.delete(item.id);
}

/** 处理一条道具区间冲突 */
export async function resolvePropConflict(item: PendingItem, choice: ResolutionChoice): Promise<void> {
  if (typeof item.id !== 'number') return;
  if (choice === 'ignore' || choice === 'local') {
    await db.pending.delete(item.id);
    return;
  }
  const prop = await db.props.where('uid').equals(item.refUid).first();
  if (!prop) {
    await db.pending.delete(item.id);
    return;
  }
  await updatePropTracked(item.shotCode, prop, item.incoming as PropPayload);
  await db.pending.delete(item.id);
}

/**
 * 认领帧序外 / 找不到镜头的帧：指定目标镜头，追加为该镜头最后一帧。
 * 若本机没有该帧（只有对方值），则按对方曝光快照补建一帧。
 * 追加后待整理清除，原帧 / 新帧数据都保留。
 */
export async function claimOrphanFrame(
  item: PendingItem,
  targetShotId: number,
): Promise<void> {
  if (typeof item.id !== 'number') return;
  const local = item.local as (Record<string, unknown> & { uid?: string }) | undefined;
  const uid =
    typeof local?.uid === 'string'
      ? local.uid
      : item.reason === 'unknown-frame'
        ? item.refUid
        : '';
  if (!uid) {
    await db.pending.delete(item.id);
    return;
  }

  const shot = await db.shots.get(targetShotId);
  const peers = await db.frames.where('shotId').equals(targetShotId).toArray();
  const frameNo = peers.length + 1;
  const existing = await db.frames.where('uid').equals(uid).first();

  if (existing) {
    await db.frames.update(existing.id as number, toPlain({ shotId: targetShotId, frameNo }));
  } else if (shot) {
    // 只有对方曝光值：按快照补建到目标镜头段尾，身份沿用对方 frameUid
    const incoming = (item.incoming ?? {}) as Record<string, unknown>;
    const shotCount = (incoming.shotCount === 1 || incoming.shotCount === 3 ? incoming.shotCount : 2) as 1 | 2 | 3;
    const newFrame: FrameEntry = {
      frameNo,
      shotId: targetShotId,
      shotCount,
      exposureSec: typeof incoming.exposureSec === 'number' ? incoming.exposureSec : 0.25,
      aperture: typeof incoming.aperture === 'number' ? incoming.aperture : 5.6,
      iso: typeof incoming.iso === 'number' ? incoming.iso : 200,
      shutterAngle: typeof incoming.shutterAngle === 'number' ? incoming.shutterAngle : 180,
      lighting: typeof incoming.lighting === 'string' ? incoming.lighting : '',
      propOffsetMm: typeof incoming.propOffsetMm === 'number' ? incoming.propOffsetMm : 0,
      note: `认领自设备交接（${item.shotCode}）`,
      uid,
      rev: 1,
      lastChange: { deviceId: item.op?.deviceId ?? 'claimed', seq: item.op?.seq ?? 1 },
      trajectory: 'stale',
      updatedAt: Date.now(),
    };
    await db.frames.add(toPlain(newFrame));
  }
  await db.pending.delete(item.id);
}
