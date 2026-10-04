/**
 * 交接合并引擎（纯函数，不碰 IndexedDB / DOM）。
 *
 * 规则：
 *  - 不同帧 / 不同道具：直接并入。
 *  - 同一帧曝光分组、同一道具行两边都从同一版本改过（值不同）：并列保留为待整理，
 *    选定前不改本机数据（本地行原样不动）。
 *  - 帧序操作先于其它操作处理（两阶段），按 uid 对位重排；本机多出的帧不删除，
 *    追加到段尾并标 frame-orphan 待整理。
 *  - 帧序变化后道具轨迹失效重算：区间整体落到帧序外 → prop-offrange 待整理；
 *    部分越界 → 夹回新帧序并标 stale；全部标 stale 供轨迹页复核。
 *  - 实拍按条并入（takeUid 去重），结束后同步剩余张数 / 完成百分比 / 镜头帧区间。
 */
import type { Shot, ShotStatus } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { durationToFrames } from '../utils/frameMath';
import type {
  ExposurePayload,
  FrameOrderOp,
  HandOp,
  ImportReport,
  PropPayload,
  ShotUpsertOp,
} from './types';
import type { PendingItem, PendingReason } from './dbTypes';

export interface MergeInput {
  shots: Shot[];
  frames: FrameEntry[];
  props: PropState[];
  takes: TakeLog[];
  /** 已应用操作键 `${deviceId}\\u0000${seq}` */
  appliedKeys: Set<string>;
  /** 库中已有待整理项的键 `${reason}:${refUid}`，避免误删无关待整理 */
  existingPendingKeys?: Set<string>;
}

export interface MergeOutcome {
  shots: Shot[];
  frames: FrameEntry[];
  props: PropState[];
  takes: TakeLog[];
  pending: PendingItem[];
  /** 本次合并后应删除的旧待整理键（冲突被选优 / 帧已补出 / 区间重新落位） */
  resolvedPendingKeys: Set<string>;
  /** 本机缺失、由交接包新建的镜头：镜号 → 临时负 id（落库时换成真实 id） */
  newShots: { code: string; tempId: number; shot: Shot }[];
  /** 包内全部操作（含已应用） */
  appliedOps: HandOp[];
  /** 本次真正新并入的操作 */
  newOps: HandOp[];
  /** 合并后将新占用的行（新帧 / 新道具 / 新实拍），供容量预估 */
  newFrameUids: Set<string>;
  newPropUids: Set<string>;
  newTakeUids: Set<string>;
  report: Omit<ImportReport, 'packageDeviceId'>;
}

const originOf = (op: HandOp) => ({ deviceId: op.deviceId, seq: op.seq });
const opKey = (deviceId: string, seq: number) => `${deviceId} ${seq}`;

function ensureFrameMeta(row: FrameEntry): FrameEntry {
  if (!row.uid) row.uid = `f-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  if (typeof row.rev !== 'number') row.rev = 1;
  if (!row.lastChange) row.lastChange = { deviceId: 'legacy-upgrade', seq: 1 };
  if (row.trajectory !== 'stale') row.trajectory = 'ok';
  return row;
}

function ensurePropMeta(row: PropState): PropState {
  if (!row.uid) row.uid = `p-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  if (typeof row.rev !== 'number') row.rev = 1;
  if (!row.lastChange) row.lastChange = { deviceId: 'legacy-upgrade', seq: 1 };
  if (row.trajectory !== 'stale') row.trajectory = 'ok';
  return row;
}

function ensureTakeMeta(row: TakeLog): TakeLog {
  if (!row.uid) row.uid = `t-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  if (typeof row.rev !== 'number') row.rev = 1;
  if (!row.lastChange) row.lastChange = { deviceId: 'legacy-upgrade', seq: 1 };
  return row;
}

const EXPOSURE_KEYS: (keyof ExposurePayload)[] = [
  'shotCount',
  'exposureSec',
  'aperture',
  'iso',
  'shutterAngle',
  'lighting',
  'propOffsetMm',
  'note',
];

function sameExposure(a: FrameEntry, b: ExposurePayload): boolean {
  return EXPOSURE_KEYS.every((k) => a[k] === b[k]);
}

function samePropPayload(a: PropState, b: PropPayload): boolean {
  return (
    a.name === b.name &&
    a.fromFrame === b.fromFrame &&
    a.toFrame === b.toFrame &&
    a.posX === b.posX &&
    a.posY === b.posY &&
    a.posZ === b.posZ &&
    a.rotation === b.rotation &&
    a.fixation === b.fixation
  );
}

/** 预估合并后总行数（仅大包校验容量时调用） */
export function projectRowCounts(input: MergeInput, ops: HandOp[], pendingToAdd: number): number {
  const newFrameUids = new Set<string>();
  const newPropUids = new Set<string>();
  const newTakeUids = new Set<string>();
  const knownFrameUids = new Set(input.frames.map((f) => f.uid).filter(Boolean));
  const knownPropUids = new Set(input.props.map((p) => p.uid).filter(Boolean));
  const knownTakeUids = new Set(input.takes.map((t) => t.uid).filter(Boolean));
  const shotCodes = new Set(input.shots.map((s) => s.code));

  for (const op of ops) {
    if (input.appliedKeys.has(opKey(op.deviceId, op.seq))) continue;
    if (!shotCodes.has(op.shotCode)) continue;
    if (op.op === 'frame.order') {
      for (const snap of op.frames) {
        if (!knownFrameUids.has(snap.uid)) newFrameUids.add(snap.uid);
      }
    } else if (op.op === 'prop.upsert') {
      if (!knownPropUids.has(op.propUid)) newPropUids.add(op.propUid);
    } else if (op.op === 'take.add') {
      if (!knownTakeUids.has(op.takeUid)) newTakeUids.add(op.takeUid);
    }
  }
  return (
    input.shots.length +
    input.frames.length +
    newFrameUids.size +
    input.props.length +
    newPropUids.size +
    input.takes.length +
    newTakeUids.size +
    pendingToAdd
  );
}

export function mergeHandoff(input: MergeInput, operations: HandOp[]): MergeOutcome {
  // 全程操作副本，保证输入不被修改（调用方在容量 / 校验失败时仍持有原记录）
  const shots = input.shots.map((s) => ({ ...s }));
  const frames = input.frames.map((f) => ensureFrameMeta({ ...f }));
  const props = input.props.map((p) => ensurePropMeta({ ...p }));
  const takes = input.takes.map((t) => ensureTakeMeta({ ...t }));

  const existingPendingKeys = input.existingPendingKeys ?? new Set<string>();
  const pendingMap = new Map<string, PendingItem>();
  const resolvedPendingKeys = new Set<string>();
  const appliedOps: HandOp[] = [];
  const newOps: HandOp[] = [];
  const newFrameUids = new Set<string>();
  const newPropUids = new Set<string>();
  const newTakeUids = new Set<string>();
  const reshapedShots = new Set<string>();
  const newShots: { code: string; tempId: number; shot: Shot }[] = [];

  let skipped = 0;
  let conflictCount = 0;
  let unlandedCount = 0;

  const shotByCode = (code: string) => shots.find((s) => s.code === code);
  const frameByUid = (uid: string) => frames.find((f) => f.uid === uid);
  const propByUid = (uid: string) => props.find((p) => p.uid === uid);

  function addPending(key: string, item: Omit<PendingItem, 'id' | 'createdAt'>) {
    if (pendingMap.has(key)) return;
    pendingMap.set(key, { ...item, createdAt: Date.now() });
    // 库里已有的待整理不计入本次新增统计，但仍要在结果里带出来
    if (!existingPendingKeys.has(key)) {
      if (item.reason.endsWith('-conflict')) conflictCount += 1;
      else unlandedCount += 1;
    }
  }

  function dropPending(key: string) {
    if (pendingMap.has(key)) {
      pendingMap.delete(key);
      if (!existingPendingKeys.has(key)) {
        // 本次刚产生又被后续操作消解：回退新增计数
        const reason = key.split(':')[0];
        if (reason.endsWith('-conflict')) conflictCount = Math.max(0, conflictCount - 1);
        else unlandedCount = Math.max(0, unlandedCount - 1);
      }
    }
    // 库里原有、本次不再成立的待整理 → 导入后删除
    if (existingPendingKeys.has(key)) resolvedPendingKeys.add(key);
  }

  /** 第零阶段：镜头建档（不同镜头直接并入；同镜号更新参数） */
  function applyShotUpsert(op: ShotUpsertOp) {
    const existing = shotByCode(op.shotCode);
    if (existing) {
      // 只并入建档参数；帧区间 / 时长由后续 frame.order 按实际帧数重算，进度由实拍回写
      existing.sceneName = op.sceneName;
      existing.fps = op.fps;
      existing.startFrame = op.startFrame;
      existing.owner = op.owner || existing.owner;
      if (op.status) existing.status = op.status as ShotStatus;
      existing.updatedAt = op.at;
      return;
    }
    const tempId = -newShots.length - 1;
    const count = Math.max(1, Math.ceil(op.durationSec * op.fps));
    const shot: Shot = {
      id: tempId,
      code: op.shotCode,
      sceneName: op.sceneName,
      fps: op.fps,
      durationSec: op.durationSec,
      startFrame: op.startFrame,
      endFrame: op.startFrame + count - 1,
      status: (op.status as ShotStatus) ?? '未开机',
      owner: op.owner,
      progressPercent: 0,
      createdAt: op.at,
      updatedAt: op.at,
    };
    shots.push(shot);
    newShots.push({ code: op.shotCode, tempId, shot });
  }

  /** 第一阶段：帧序变化（移动 / 插入 / 删除） */
  function applyOrderOp(op: FrameOrderOp) {
    const shot = shotByCode(op.shotCode);
    if (!shot) {
      addPending(`unknown-shot:${op.shotCode}:${op.deviceId}`, {
        shotCode: op.shotCode,
        reason: 'unknown-shot',
        refUid: op.shotCode,
        op,
        note: `镜号 ${op.shotCode} 在本机不存在，设备 ${op.deviceId} 的帧序改动无落点`,
      });
      return;
    }

    const mine = frames.filter((f) => f.shotId === shot.id);
    const byUid = new Map(mine.map((f) => [f.uid as string, f]));
    const orderedUids = new Set(op.order);

    const nextFrames: FrameEntry[] = [];
    for (const uid of op.order) {
      const existing = byUid.get(uid);
      if (existing) {
        nextFrames.push(existing);
        continue;
      }
      const snap = op.frames.find((f) => f.uid === uid);
      if (!snap) {
        // 顺序引用了双方都没有的帧：不臆造，记待整理
        addPending(`unknown-frame:${uid}`, {
          shotCode: op.shotCode,
          reason: 'unknown-frame',
          refUid: uid,
          op,
          note: `帧 ${uid} 在帧序中被引用，但双方都没有该帧数据`,
        });
        continue;
      }
      const created = ensureFrameMeta({
        frameNo: shot.startFrame,
        shotId: shot.id as number,
        ...snap.frame,
        uid: snap.uid,
        rev: snap.rev,
        lastChange: snap.lastChange,
        trajectory: 'ok',
        updatedAt: op.at,
      });
      frames.push(created);
      newFrameUids.add(created.uid as string);
      nextFrames.push(created);
      dropPending(`unknown-frame:${uid}`);
    }

    // 本机多出、顺序里找不到落点的帧：保留数据，追加段尾并标待整理
    for (const extra of mine) {
      if (!orderedUids.has(extra.uid as string)) {
        nextFrames.push(extra);
        addPending(`frame-orphan:${extra.uid}`, {
          shotCode: op.shotCode,
          reason: 'frame-orphan',
          refUid: extra.uid as string,
          op,
          local: { ...extra },
          note: `帧 ${extra.frameNo} 在设备 ${op.deviceId} 的新帧序中没有落点，已追加到段尾待人工整理`,
        });
      }
    }

    // 重排：帧号一律从镜头 startFrame 起连续压缩（与 useFrameSequence 排帧一致）
    const others = frames.filter((f) => f.shotId !== shot.id);
    let frameNo = shot.startFrame;
    nextFrames.forEach((f) => {
      f.frameNo = frameNo;
      frameNo += 1;
    });
    frames.length = 0;
    frames.push(...others, ...nextFrames);
    reshapedShots.add(op.shotCode);

    // 镜头帧区间 / 时长随帧序重算
    const count = nextFrames.length;
    shot.endFrame = shot.startFrame + count - 1;
    shot.durationSec = Math.round((count / (shot.fps || 24)) * 1000) / 1000;
    shot.updatedAt = op.at;
  }

  /** 帧序变化后：道具轨迹失效重算 */
  function reshapeProps(shot: Shot) {
    const shotFrames = frames.filter((f) => f.shotId === shot.id);
    const maxFrameNo = shotFrames.length ? Math.max(...shotFrames.map((f) => f.frameNo)) : shot.startFrame - 1;
    for (const p of props.filter((x) => x.shotId === shot.id)) {
      p.trajectory = 'stale';
      if (p.fromFrame > maxFrameNo) {
        addPending(`prop-offrange:${p.uid}`, {
          shotCode: shot.code,
          reason: 'prop-offrange',
          refUid: p.uid as string,
          local: { ...p },
          note: `道具「${p.name}」区间 ${p.fromFrame}–${p.toFrame} 整体落在新帧序（止于 ${maxFrameNo}）之外`,
        });
        continue;
      }
      dropPending(`prop-offrange:${p.uid}`);
      if (p.toFrame > maxFrameNo) p.toFrame = maxFrameNo;
    }
  }

  /** 第二阶段：曝光 / 道具 / 实拍 */
  function applyExposure(op: Extract<HandOp, { op: 'frame.exposure' }>) {
    if (!shotByCode(op.shotCode)) {
      addPending(`unknown-shot:${op.shotCode}:${op.deviceId}`, {
        shotCode: op.shotCode,
        reason: 'unknown-shot',
        refUid: op.frameUid,
        op,
        note: `镜号 ${op.shotCode} 在本机不存在，曝光改动无落点`,
      });
      return;
    }
    const frame = frameByUid(op.frameUid);
    if (!frame) {
      addPending(`unknown-frame:${op.frameUid}`, {
        shotCode: op.shotCode,
        reason: 'unknown-frame',
        refUid: op.frameUid,
        op,
        incoming: { ...op.payload },
        note: `帧 ${op.frameUid} 在本机找不到，设备 ${op.deviceId} 的曝光改动待认领`,
      });
      return;
    }
    if (sameExposure(frame, op.payload)) {
      skipped += 1;
      return;
    }
    const diverged =
      frame.rev !== op.baseRev && frame.lastChange?.deviceId && frame.lastChange.deviceId !== op.deviceId;
    if (frame.rev === op.baseRev || !diverged) {
      Object.assign(frame, op.payload, {
        rev: Math.max(frame.rev ?? 1, op.baseRev + 1),
        lastChange: originOf(op),
        trajectory: frame.trajectory === 'stale' ? 'stale' : 'ok',
        updatedAt: op.at,
      });
      dropPending(`exposure-conflict:${op.frameUid}`);
      return;
    }
    // 两边都从不同版本改过：并列保留，本机行不动
    addPending(`exposure-conflict:${op.frameUid}`, {
      shotCode: op.shotCode,
      reason: 'exposure-conflict',
      refUid: op.frameUid,
      op,
      local: { frameNo: frame.frameNo, ...EXPOSURE_KEYS.reduce((acc, k) => ({ ...acc, [k]: frame[k] }), {}) },
      incoming: { frameNo: op.frameNo, ...op.payload },
      note: `第 ${frame.frameNo} 帧曝光两边都改过（本机 rev ${frame.rev}，对方基于 rev ${op.baseRev}）`,
    });
  }

  function applyProp(op: Extract<HandOp, { op: 'prop.upsert' }>) {
    if (!shotByCode(op.shotCode)) {
      addPending(`unknown-shot:${op.shotCode}:${op.deviceId}`, {
        shotCode: op.shotCode,
        reason: 'unknown-shot',
        refUid: op.propUid,
        op,
        note: `镜号 ${op.shotCode} 在本机不存在，道具区间无落点`,
      });
      return;
    }
    const existing = propByUid(op.propUid);
    if (!existing) {
      // 不同道具 / 不同区间行：直接并入
      const shot = shotByCode(op.shotCode);
      const created = ensurePropMeta({
        name: op.payload.name,
        shotId: shot?.id ?? -1,
        fromFrame: op.payload.fromFrame,
        toFrame: op.payload.toFrame,
        posX: op.payload.posX,
        posY: op.payload.posY,
        posZ: op.payload.posZ,
        rotation: op.payload.rotation,
        fixation: op.payload.fixation,
        uid: op.propUid,
        rev: op.baseRev + 1,
        lastChange: originOf(op),
        trajectory: 'ok',
        updatedAt: op.at,
      });
      props.push(created);
      newPropUids.add(op.propUid);
      dropPending(`unknown-prop:${op.propUid}`);
      return;
    }
    if (samePropPayload(existing, op.payload)) {
      skipped += 1;
      return;
    }
    const diverged =
      existing.rev !== op.baseRev &&
      existing.lastChange?.deviceId &&
      existing.lastChange.deviceId !== op.deviceId;
    if (existing.rev === op.baseRev || !diverged) {
      const payload: PropPayload = op.payload;
      Object.assign(existing, payload, {
        rev: Math.max(existing.rev ?? 1, op.baseRev + 1),
        lastChange: originOf(op),
        updatedAt: op.at,
      });
      dropPending(`prop-conflict:${op.propUid}`);
      return;
    }
    addPending(`prop-conflict:${op.propUid}`, {
      shotCode: op.shotCode,
      reason: 'prop-conflict',
      refUid: op.propUid,
      op,
      local: {
        name: existing.name,
        fromFrame: existing.fromFrame,
        toFrame: existing.toFrame,
        posX: existing.posX,
        posY: existing.posY,
        posZ: existing.posZ,
        rotation: existing.rotation,
        fixation: existing.fixation,
      },
      incoming: { ...op.payload },
      note: `道具「${existing.name}」区间 ${existing.fromFrame}–${existing.toFrame} 两边都改过（本机 rev ${existing.rev}，对方基于 rev ${op.baseRev}）`,
    });
  }

  function applyTake(op: Extract<HandOp, { op: 'take.add' }>) {
    if (!shotByCode(op.shotCode)) {
      addPending(`unknown-shot:${op.shotCode}:${op.deviceId}`, {
        shotCode: op.shotCode,
        reason: 'unknown-shot',
        refUid: op.takeUid,
        op,
        incoming: { date: op.date, takenFrames: op.takenFrames, wastedFrames: op.wastedFrames },
        note: `镜号 ${op.shotCode} 在本机不存在，实拍 ${op.takenFrames} 张待认领`,
      });
      return;
    }
    if (takes.some((t) => t.uid === op.takeUid)) {
      skipped += 1;
      return;
    }
    const shot = shotByCode(op.shotCode);
    const row = ensureTakeMeta({
      date: op.date,
      shotCode: op.shotCode,
      shotId: shot?.id ?? -1,
      takenFrames: op.takenFrames,
      wastedFrames: op.wastedFrames,
      remainingFrames: 0,
      percent: 0,
      uid: op.takeUid,
      rev: 1,
      lastChange: originOf(op),
      updatedAt: op.at,
    });
    takes.push(row);
    newTakeUids.add(op.takeUid);
  }

  // ---- 按 设备 → 应用阶段（镜头建档 / 帧序 / 其余）→ 顺序号 稳定排序 ----
  const phase = (op: HandOp) => (op.op === 'shot.upsert' ? 0 : op.op === 'frame.order' ? 1 : 2);
  const sorted = operations.slice().sort((a, b) => {
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    if (phase(a) !== phase(b)) return phase(a) - phase(b);
    return a.seq - b.seq;
  });
  const shotOps = sorted.filter((op): op is ShotUpsertOp => op.op === 'shot.upsert');
  const orderOps = sorted.filter((op): op is FrameOrderOp => op.op === 'frame.order');
  const restOps = sorted.filter((op) => op.op !== 'frame.order' && op.op !== 'shot.upsert');

  for (const op of [...shotOps, ...orderOps, ...restOps]) {
    if (input.appliedKeys.has(opKey(op.deviceId, op.seq))) {
      skipped += 1;
      appliedOps.push(op);
      continue;
    }
    if (op.op === 'shot.upsert') applyShotUpsert(op);
    else if (op.op === 'frame.order') applyOrderOp(op);
    else if (op.op === 'frame.exposure') applyExposure(op);
    else if (op.op === 'prop.upsert') applyProp(op);
    else applyTake(op);
    appliedOps.push(op);
    newOps.push(op);
  }

  // 帧序变化后道具轨迹重算
  for (const code of reshapedShots) {
    const shot = shotByCode(code);
    if (shot) reshapeProps(shot);
  }

  // 实拍剩余张数 / 完成百分比同步
  const progressShots: string[] = [];
  const affectedShotIds = new Set<number>();
  for (const op of newOps) {
    const shot = shotByCode(op.shotCode);
    if (shot && typeof shot.id === 'number' && (op.op === 'take.add' || reshapedShots.has(op.shotCode))) {
      affectedShotIds.add(shot.id);
    }
  }
  for (const shotId of affectedShotIds) {
    const shot = shots.find((s) => s.id === shotId);
    if (!shot) continue;
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const rows = takes.filter((t) => t.shotId === shotId);
    const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const remaining = Math.max(0, planned - taken);
    const percent = Math.min(100, Math.round((taken / Math.max(1, planned)) * 100));
    for (const r of rows) {
      r.remainingFrames = remaining;
      r.percent = percent;
    }
    shot.progressPercent = percent;
    progressShots.push(shot.code);
  }

  const pending = [...pendingMap.values()];

  return {
    shots,
    frames,
    props,
    takes,
    pending,
    resolvedPendingKeys,
    newShots,
    appliedOps,
    newOps,
    newFrameUids,
    newPropUids,
    newTakeUids,
    report: {
      total: operations.length,
      applied: newOps.length,
      skipped,
      conflicts: conflictCount,
      unlanded: unlandedCount,
      reshapedShots: [...reshapedShots],
      progressShots,
    },
  };
}

/** 顺序号缺口检查：包内每设备连续，且相对本机已应用水位不跳号 */
export function detectGap(operations: HandOp[], appliedKeys: Set<string>): string | null {
  const byDevice = new Map<string, number[]>();
  for (const op of operations) {
    const list = byDevice.get(op.deviceId) ?? [];
    list.push(op.seq);
    byDevice.set(op.deviceId, list);
  }
  for (const [deviceId, seqs] of byDevice) {
    const sortedSeqs = [...new Set(seqs)].sort((a, b) => a - b);
    for (let i = 1; i < sortedSeqs.length; i += 1) {
      if (sortedSeqs[i] !== sortedSeqs[i - 1] + 1) {
        return `设备 ${deviceId} 的交接包顺序号在 ${sortedSeqs[i - 1]} → ${sortedSeqs[i]} 之间缺项，请索取完整交接包`;
      }
    }
    // 找到包起点之前已应用的最高顺序号；下一包必须紧接它（包起点 ≤ 水位 + 1）
    const first = sortedSeqs[0];
    let watermark = 0;
    for (let s = first - 1; s >= 1; s -= 1) {
      if (appliedKeys.has(opKey(deviceId, s))) {
        watermark = s;
        break;
      }
    }
    if (watermark > 0 && first > watermark + 1) {
      return `设备 ${deviceId} 的顺序号缺口：本机已到 ${watermark}，交接包从 ${first} 开始，缺少中间操作`;
    }
  }
  return null;
}

export type { PendingReason };
