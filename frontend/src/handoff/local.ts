/**
 * 本机编辑 → 交接操作记录。
 * 既有页面照旧调 db/api 的普通写入；凡是需要并入交接包的改动
 * （单帧曝光、帧序变化、道具区间新增/修改、实拍登记）走这里的原子方法，
 * 在同一事务里写数据 + 追加一条带设备标识与顺序号的操作。
 */
import { db, toPlain } from '../db';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type {
  ExposurePayload,
  FrameExposureOp,
  FrameOrderOp,
  HandOp,
  OrderedFrameSnapshot,
  PropPayload,
  PropUpsertOp,
  ShotUpsertOp,
  TakeAddOp,
} from './types';
import type { HandOpLogRow } from './dbTypes';
import { getDeviceId, newUid, nextDeviceSeq } from './device';

function logRow(op: HandOp): HandOpLogRow {
  return {
    deviceId: op.deviceId,
    seq: op.seq,
    opType: op.op,
    shotCode: op.shotCode,
    appliedAt: op.at,
    op: toPlain(op),
  };
}

/** 新建镜头并记录 shot.upsert 交接操作，返回新 id */
export async function addShotTracked(shot: Shot): Promise<number> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const seq = nextDeviceSeq();
  const row: Shot = { ...toPlain(shot), createdAt: shot.createdAt || now, updatedAt: now };
  const handOp: ShotUpsertOp = {
    op: 'shot.upsert',
    deviceId,
    seq,
    at: now,
    shotCode: row.code,
    sceneName: row.sceneName,
    fps: row.fps,
    durationSec: row.durationSec,
    startFrame: row.startFrame,
    status: row.status,
    owner: row.owner,
  };
  return db.transaction('rw', db.shots, db.handoffOps, async () => {
    const id = await db.shots.add(row);
    await db.handoffOps.add(toPlain(logRow(handOp)));
    return id;
  });
}

/**
 * 改一帧曝光分组并记录交接操作。
 * 返回更新后的帧（rev + 1，lastChange 指向本机）。
 */
export async function editFrameExposure(
  shotCode: string,
  frame: FrameEntry,
  patch: Partial<ExposurePayload>,
): Promise<FrameEntry | null> {
  if (typeof frame.id !== 'number') return null;
  const now = Date.now();
  const deviceId = getDeviceId();
  const seq = nextDeviceSeq();
  const baseRev = frame.rev ?? 1;
  const next: FrameEntry = {
    ...frame,
    ...patch,
    uid: frame.uid ?? newUid(),
    rev: baseRev + 1,
    lastChange: { deviceId, seq },
    trajectory: frame.trajectory ?? 'ok',
    updatedAt: now,
  };
  const { id: frameId, ...rest } = next;
  const handOp: FrameExposureOp = {
    op: 'frame.exposure',
    deviceId,
    seq,
    at: now,
    shotCode,
    frameUid: next.uid as string,
    frameNo: next.frameNo,
    baseRev,
    payload: {
      shotCount: next.shotCount,
      exposureSec: next.exposureSec,
      aperture: next.aperture,
      iso: next.iso,
      shutterAngle: next.shutterAngle,
      lighting: next.lighting,
      propOffsetMm: next.propOffsetMm,
      note: next.note,
    },
  };
  await db.transaction('rw', db.frames, db.handoffOps, async () => {
    await db.frames.update(frameId as number, toPlain(rest));
    await db.handoffOps.add(toPlain(logRow(handOp)));
  });
  return next;
}

function snapshotOf(frame: FrameEntry): OrderedFrameSnapshot {
  return {
    uid: frame.uid as string,
    frame: {
      shotCount: frame.shotCount,
      exposureSec: frame.exposureSec,
      aperture: frame.aperture,
      iso: frame.iso,
      shutterAngle: frame.shutterAngle,
      lighting: frame.lighting,
      propOffsetMm: frame.propOffsetMm,
      note: frame.note,
    },
    rev: frame.rev ?? 1,
    lastChange: frame.lastChange ?? { deviceId: getDeviceId(), seq: 1 },
  };
}

/**
 * 帧序变化（移动 / 插入 / 删除后整段落库）：写帧 + 追加 frame.order 操作。
 * orderedFrames 为重排后的该镜头全部帧（新帧需已带 uid / rev）。
 */
export async function replaceFrameOrder(
  shotCode: string,
  shotId: number,
  orderedFrames: FrameEntry[],
): Promise<void> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const seq = nextDeviceSeq();
  const stamped = orderedFrames.map((f) => ({
    ...toPlain(f),
    shotId,
    uid: f.uid ?? newUid(),
    rev: typeof f.rev === 'number' ? f.rev : 1,
    lastChange: f.lastChange ?? { deviceId, seq: 1 },
    trajectory: f.trajectory ?? 'ok',
    updatedAt: f.updatedAt ?? now,
  }));
  const handOp: FrameOrderOp = {
    op: 'frame.order',
    deviceId,
    seq,
    at: now,
    shotCode,
    order: stamped.map((f) => f.uid as string),
    frames: stamped.map(snapshotOf),
  };
  await db.transaction('rw', db.frames, db.props, db.handoffOps, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    await db.frames.bulkAdd(stamped);

    // 帧序变化 → 本机道具轨迹同样失效重算：超出新区间的夹回，全部标 stale 待复核
    const maxFrameNo = stamped.length ? stamped[stamped.length - 1].frameNo : 0;
    await db.props
      .where('shotId')
      .equals(shotId)
      .modify((p: PropState) => {
        p.trajectory = 'stale';
        if (p.toFrame > maxFrameNo) p.toFrame = maxFrameNo;
        if (p.fromFrame > maxFrameNo) {
          // 区间整体落空：保留原 fromFrame 供人工认领，仅标记
          p.fromFrame = Math.max(1, Math.min(p.fromFrame, maxFrameNo || 1));
        }
        p.updatedAt = now;
      });

    await db.handoffOps.add(toPlain(logRow(handOp)));
  });
}

/** 新增道具区间并记录交接操作，返回新 id */
export async function addPropTracked(shotCode: string, prop: PropState): Promise<number> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const seq = nextDeviceSeq();
  const row: PropState = {
    ...toPlain(prop),
    uid: prop.uid ?? newUid(),
    rev: 1,
    lastChange: { deviceId, seq },
    trajectory: 'ok',
    updatedAt: now,
  };
  const handOp: PropUpsertOp = {
    op: 'prop.upsert',
    deviceId,
    seq,
    at: now,
    shotCode,
    propUid: row.uid as string,
    baseRev: 0,
    payload: {
      name: row.name,
      fromFrame: row.fromFrame,
      toFrame: row.toFrame,
      posX: row.posX,
      posY: row.posY,
      posZ: row.posZ,
      rotation: row.rotation,
      fixation: row.fixation,
    },
  };
  return db.transaction('rw', db.props, db.handoffOps, async () => {
    const id = await db.props.add(row);
    await db.handoffOps.add(toPlain(logRow(handOp)));
    return id;
  });
}

/** 修改道具区间并记录交接操作 */
export async function updatePropTracked(
  shotCode: string,
  prop: PropState,
  patch: Partial<PropPayload>,
): Promise<void> {
  if (typeof prop.id !== 'number') return;
  const now = Date.now();
  const deviceId = getDeviceId();
  const seq = nextDeviceSeq();
  const baseRev = prop.rev ?? 1;
  const next: PropState = {
    ...prop,
    ...patch,
    uid: prop.uid ?? newUid(),
    rev: baseRev + 1,
    lastChange: { deviceId, seq },
    trajectory: 'ok',
    updatedAt: now,
  };
  const { id: propId, ...rest } = next;
  const handOp: PropUpsertOp = {
    op: 'prop.upsert',
    deviceId,
    seq,
    at: now,
    shotCode,
    propUid: next.uid as string,
    baseRev,
    payload: {
      name: next.name,
      fromFrame: next.fromFrame,
      toFrame: next.toFrame,
      posX: next.posX,
      posY: next.posY,
      posZ: next.posZ,
      rotation: next.rotation,
      fixation: next.fixation,
    },
  };
  await db.transaction('rw', db.props, db.handoffOps, async () => {
    await db.props.update(propId as number, toPlain(rest));
    await db.handoffOps.add(toPlain(logRow(handOp)));
  });
}

/** 登记实拍并记录交接操作，返回新 id */
export async function addTakeTracked(
  shotCode: string,
  take: TakeLog,
): Promise<number> {
  const now = Date.now();
  const deviceId = getDeviceId();
  const seq = nextDeviceSeq();
  const row: TakeLog = {
    ...toPlain(take),
    uid: take.uid ?? newUid(),
    rev: 1,
    lastChange: { deviceId, seq },
    updatedAt: now,
  };
  const handOp: TakeAddOp = {
    op: 'take.add',
    deviceId,
    seq,
    at: now,
    shotCode,
    takeUid: row.uid as string,
    date: row.date,
    takenFrames: row.takenFrames,
    wastedFrames: row.wastedFrames,
  };
  return db.transaction('rw', db.takes, db.handoffOps, async () => {
    const newId = await db.takes.add(row);
    await db.handoffOps.add(toPlain(logRow(handOp)));
    return newId;
  });
}
