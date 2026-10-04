/**
 * 拍摄交接引擎：
 * - buildHandoverPackage：把本机全量快照打成可粘贴 JSON 包（每条带 syncUid 与修订戳）
 * - mergeHandover：导入他机包
 *   · 不同帧 / 不同道具 / 不同实拍：直接并入
 *   · 同一帧曝光或同一道具帧区间两边都改过：并列保留（本机数据不动，他机版本进待整理）
 *   · 帧序变化：道具轨迹失效检查，实拍剩余张数同步重算，找不到落点的条目标待整理
 *   · 超 1000 项先做容量预检，不足则整单拒绝；事务失败自动回滚，原记录保留，可重试
 */
import { db, toPlain } from '../db';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { Shot } from '../types/shot';
import type { TakeLog } from '../types/take';
import {
  HANDOVER_FORMAT,
  HANDOVER_ITEM_LIMIT,
  HANDOVER_VERSION,
  emptyMergeReport,
  type HandoverFrame,
  type HandoverPackage,
  type HandoverProp,
  type HandoverShot,
  type HandoverTake,
  type MergeReport,
  type PendingEntry,
  type RevStamp,
} from '../types/sync';
import { getDevice, raiseSeqWatermark } from '../utils/device';
import { durationToFrames } from '../utils/frameMath';

/* ---------------- 导出 ---------------- */

function shotToHandover(shot: Shot): HandoverShot {
  return {
    syncUid: shot.syncUid,
    code: shot.code,
    sceneName: shot.sceneName,
    fps: shot.fps,
    durationSec: shot.durationSec,
    startFrame: shot.startFrame,
    endFrame: shot.endFrame,
    status: shot.status,
    owner: shot.owner,
    progressPercent: shot.progressPercent,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
    rev: shot.rev,
  };
}

export async function buildHandoverPackage(): Promise<{ text: string; pkg: HandoverPackage; itemCount: number }> {
  const [shots, frames, props, takes] = await Promise.all([
    db.shots.toArray(),
    db.frames.toArray(),
    db.props.toArray(),
    db.takes.toArray(),
  ]);
  const shotUidById = new Map(shots.map((s) => [s.id, s.syncUid]));
  const { deviceId, deviceName } = getDevice();
  const pkg: HandoverPackage = {
    format: HANDOVER_FORMAT,
    version: HANDOVER_VERSION,
    deviceId,
    deviceName,
    exportedAt: Date.now(),
    shots: shots.map(shotToHandover),
    frames: frames
      .filter((f) => shotUidById.has(f.shotId))
      .map((f): HandoverFrame => ({
        syncUid: f.syncUid,
        shotSyncUid: shotUidById.get(f.shotId) ?? '',
        frameNo: f.frameNo,
        shotCount: f.shotCount,
        exposureSec: f.exposureSec,
        aperture: f.aperture,
        iso: f.iso,
        shutterAngle: f.shutterAngle,
        lighting: f.lighting,
        propOffsetMm: f.propOffsetMm,
        note: f.note,
        updatedAt: f.updatedAt,
        rev: f.rev,
        exposureRev: f.exposureRev,
        offsetRev: f.offsetRev,
        pendingTag: f.pendingTag,
      })),
    props: props
      .filter((p) => shotUidById.has(p.shotId))
      .map((p): HandoverProp => ({
        syncUid: p.syncUid,
        shotSyncUid: shotUidById.get(p.shotId) ?? '',
        name: p.name,
        fromFrame: p.fromFrame,
        toFrame: p.toFrame,
        posX: p.posX,
        posY: p.posY,
        posZ: p.posZ,
        rotation: p.rotation,
        fixation: p.fixation,
        updatedAt: p.updatedAt,
        rev: p.rev,
        rangeRev: p.rangeRev,
        posRev: p.posRev,
        pendingTag: p.pendingTag,
      })),
    takes: takes
      .filter((t) => shotUidById.has(t.shotId))
      .map((t): HandoverTake => ({
        syncUid: t.syncUid,
        shotSyncUid: shotUidById.get(t.shotId) ?? '',
        date: t.date,
        shotCode: t.shotCode,
        takenFrames: t.takenFrames,
        wastedFrames: t.wastedFrames,
        remainingFrames: t.remainingFrames,
        percent: t.percent,
        updatedAt: t.updatedAt,
        rev: t.rev,
        pendingTag: t.pendingTag,
      })),
  };
  const itemCount = pkg.shots.length + pkg.frames.length + pkg.props.length + pkg.takes.length;
  return { text: JSON.stringify(pkg, null, 2), pkg, itemCount };
}

/* ---------------- 解析与预检 ---------------- */

export function parseHandoverText(text: string): HandoverPackage {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('交接包不是合法 JSON，请确认完整粘贴了导出内容');
  }
  const pkg = data as Partial<HandoverPackage>;
  if (!pkg || pkg.format !== HANDOVER_FORMAT) {
    throw new Error('格式不识别：缺少 gbstopmotion-handover 标识');
  }
  if (typeof pkg.deviceId !== 'string' || !pkg.deviceId) throw new Error('交接包缺少来源设备标识');
  for (const key of ['shots', 'frames', 'props', 'takes'] as const) {
    if (!Array.isArray(pkg[key])) throw new Error(`交接包内容不完整：${key} 缺失`);
  }
  return pkg as HandoverPackage;
}

export function packageItemCount(pkg: HandoverPackage): number {
  return pkg.shots.length + pkg.frames.length + pkg.takes.length + pkg.props.length;
}

/**
 * 容量预检：超过 1000 项时估算 IndexedDB 余量，不足则拒绝导入。
 * 估算失败（浏览器不支持 storage.estimate）时放行，交由写入事务兜底。
 */
export async function ensureCapacity(pkg: HandoverPackage): Promise<{ ok: boolean; freeBytes?: number; needBytes?: number }> {
  const count = packageItemCount(pkg);
  if (count <= HANDOVER_ITEM_LIMIT) return { ok: true };
  const nav = (typeof navigator !== 'undefined'
    ? navigator
    : undefined) as Navigator & { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } | undefined } | undefined;
  const estimate = nav?.storage?.estimate;
  if (typeof estimate !== 'function') return { ok: true };
  try {
    const { quota = 0, usage = 0 } = await estimate.call(nav!.storage!);
    if (!quota) return { ok: true };
    // 单项平均按 1KB 估，2.5 倍安全系数覆盖索引与待整理副本
    const needBytes = Math.ceil(count * 1024 * 2.5);
    const freeBytes = Math.max(0, quota - usage);
    return { ok: freeBytes >= needBytes, freeBytes, needBytes };
  } catch {
    return { ok: true };
  }
}

/* ---------------- 合并辅助 ---------------- */

const EXPOSURE_KEYS = ['shotCount', 'exposureSec', 'aperture', 'iso', 'shutterAngle', 'lighting'] as const;
type ExposureKey = (typeof EXPOSURE_KEYS)[number];

function newerByStampOrTime(local: RevStamp, remote: RevStamp, localTime: number, remoteTime: number): boolean {
  if (local.deviceId && remote.deviceId && local.deviceId === remote.deviceId) return remote.seq > local.seq;
  return remoteTime > localTime;
}

/** 同设备增量：他机顺序号未更新则跳过 */
function sameDeviceStale(local: RevStamp, remote: RevStamp): boolean {
  return !!local.deviceId && local.deviceId === remote.deviceId && remote.seq <= local.seq;
}

function snapshotOf(row: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = row;
  void id;
  return { ...rest };
}

interface ConflictSpec {
  entry: PendingEntry;
}

interface MergeContext {
  report: MergeReport;
  pending: PendingEntry[];
  remoteDeviceName: string;
  /** 本次导入已登记的待整理键，保证重复导入同一包幂等 */
  pendingKeys: Set<string>;
}

function bumpWatermarkFromPkg(pkg: HandoverPackage): void {
  let max = 0;
  const all: RevStamp[] = [
    ...pkg.shots.map((x) => x.rev),
    ...pkg.frames.flatMap((x) => [x.rev, x.exposureRev, x.offsetRev]),
    ...pkg.props.flatMap((x) => [x.rev, x.rangeRev, x.posRev]),
    ...pkg.takes.map((x) => x.rev),
  ];
  for (const rev of all) {
    if (rev?.deviceId === getDevice().deviceId && rev.seq > max) max = rev.seq;
  }
  raiseSeqWatermark(max);
}

/* ---------------- 合并主流程 ---------------- */

export async function mergeHandover(pkgInput: HandoverPackage): Promise<MergeReport> {
  const report = emptyMergeReport();
  report.itemCount = packageItemCount(pkgInput);
  report.fromDevice = pkgInput.deviceName || pkgInput.deviceId;

  // 容量预检：本机容量不足直接拒绝，不写任何数据
  if (report.itemCount > HANDOVER_ITEM_LIMIT) {
    const cap = await ensureCapacity(pkgInput);
    if (!cap.ok) {
      report.reason = 'capacity';
      const needMb = cap.needBytes ? Math.ceil(cap.needBytes / 1024 / 1024) : 0;
      const freeMb = cap.freeBytes ? Math.floor(cap.freeBytes / 1024 / 1024) : 0;
      report.message = `交接包含 ${report.itemCount} 项，本机可用空间约 ${freeMb} MB，预计需要 ${needMb} MB，已拒绝导入，原记录未改动`;
      return report;
    }
  }

  const ctx: MergeContext = {
    report,
    pending: [],
    remoteDeviceName: pkgInput.deviceName || pkgInput.deviceId,
    pendingKeys: new Set<string>(),
  };

  try {
    // 整个导入在单个读写事务里，任一步失败整体回滚，原记录保留，可重试
    await db.transaction(
      'rw',
      db.shots,
      db.frames,
      db.props,
      db.takes,
      db.pending,
      async () => {
        const localShots = await db.shots.toArray();
        const localFrames = await db.frames.toArray();
        const localProps = await db.props.toArray();
        const localTakes = await db.takes.toArray();
        // 重复导入同一包时不重复登记待整理条目
        const existingPending = await db.pending.toArray();
        existingPending.forEach((p) => ctx.pendingKeys.add(pendingKey(p.kind, p.subject, p.syncUid)));

        /* ----- 镜头：建立 syncUid → 本地 id 映射 ----- */
        const localShotByUid = new Map(localShots.filter((s) => s.syncUid).map((s) => [s.syncUid, s]));
        const localIdByUid = new Map<string, number>();
        const remoteShotsByIdentity = new Map<string, HandoverShot>();
        pkgInput.shots.forEach((s) => remoteShotsByIdentity.set(s.syncUid, s));

        // 先插入他机新镜头
        for (const hs of pkgInput.shots) {
          const existing = localShotByUid.get(hs.syncUid);
          if (existing) {
            localIdByUid.set(hs.syncUid, existing.id as number);
            continue;
          }
          const row: Shot = {
            code: hs.code,
            sceneName: hs.sceneName,
            fps: hs.fps,
            durationSec: hs.durationSec,
            startFrame: hs.startFrame,
            endFrame: hs.endFrame,
            status: hs.status as Shot['status'],
            owner: hs.owner,
            progressPercent: hs.progressPercent,
            createdAt: hs.createdAt,
            updatedAt: hs.updatedAt,
            syncUid: hs.syncUid,
            rev: hs.rev,
          };
          const id = await db.shots.add(toPlain(row));
          localIdByUid.set(hs.syncUid, id);
          report.imported.shots += 1;
        }

        // 再合并已有镜头字段（跨设备按更新时间，同设备按顺序号）
        for (const hs of pkgInput.shots) {
          const existing = localShotByUid.get(hs.syncUid);
          if (!existing) continue;
          if (sameDeviceStale(existing.rev, hs.rev)) {
            report.skipped.shots += 1;
            continue;
          }
          const takeRemote = newerByStampOrTime(existing.rev, hs.rev, existing.updatedAt, hs.updatedAt);
          if (!takeRemote || typeof existing.id !== 'number') {
            report.skipped.shots += 1;
            continue;
          }
          await db.shots.update(existing.id, toPlain({
            code: hs.code,
            sceneName: hs.sceneName,
            fps: hs.fps,
            durationSec: hs.durationSec,
            startFrame: hs.startFrame,
            endFrame: hs.endFrame,
            status: hs.status,
            owner: hs.owner,
            updatedAt: hs.updatedAt,
            rev: hs.rev,
            // 完成百分比以导入后重算为准，这里不覆盖
          }));
          report.updated.shots += 1;
        }

        /* ----- 帧：以他机帧序为骨架并入，曝光两边都改则并列 ----- */
        const remoteFrameUids = new Set(pkgInput.frames.map((f) => f.syncUid));
        const frameOrderChangedShots = new Set<string>();

        // 按镜头分组处理
        const remoteFramesByShot = new Map<string, HandoverFrame[]>();
        for (const hf of pkgInput.frames) {
          const list = remoteFramesByShot.get(hf.shotSyncUid) ?? [];
          list.push(hf);
          remoteFramesByShot.set(hf.shotSyncUid, list);
        }

        for (const [shotUid, remoteList0] of remoteFramesByShot) {
          const shotId = localIdByUid.get(shotUid);
          if (typeof shotId !== 'number') {
            // 他机帧引用了包里没有的镜头：整批标待整理
            for (const hf of remoteList0) await orphanFrame(hf, ctx);
            continue;
          }
          const remoteList = remoteList0.slice().sort((a, b) => a.frameNo - b.frameNo);
          const locals = localFrames.filter((f) => f.shotId === shotId);
          const localsByUid = new Map(locals.filter((f) => f.syncUid).map((f) => [f.syncUid, f]));
          const merged: Array<{ row: FrameEntry; rank: number; remoteOrder: number }> = [];

          // 骨架：他机帧（共同帧做字段级合并）
          remoteList.forEach((hf, order) => {
            const local = localsByUid.get(hf.syncUid);
            if (!local) {
              merged.push({
                row: {
                  frameNo: hf.frameNo,
                  shotId,
                  shotCount: hf.shotCount as FrameEntry['shotCount'],
                  exposureSec: hf.exposureSec,
                  aperture: hf.aperture,
                  iso: hf.iso,
                  shutterAngle: hf.shutterAngle,
                  lighting: hf.lighting,
                  propOffsetMm: hf.propOffsetMm,
                  note: hf.note,
                  updatedAt: hf.updatedAt,
                  syncUid: hf.syncUid,
                  rev: hf.rev,
                  exposureRev: hf.exposureRev,
                  offsetRev: hf.offsetRev,
                  pendingTag: null,
                },
                rank: 0,
                remoteOrder: order,
              });
              report.imported.frames += 1;
              return;
            }

            // 共同帧：先判同设备增量
            if (sameDeviceStale(local.rev, hf.rev)) {
              merged.push({ row: { ...local, frameNo: hf.frameNo }, rank: 0, remoteOrder: order });
              report.skipped.frames += 1;
              return;
            }

            const next: FrameEntry = { ...local, frameNo: hf.frameNo };
            let touched = false;

            // 曝光组：两边都改过 → 并列，本机不动
            const bothExposure =
              !!local.exposureRev?.deviceId &&
              !!hf.exposureRev?.deviceId &&
              local.exposureRev.deviceId !== hf.exposureRev.deviceId &&
              EXPOSURE_KEYS.some((k) => local[k] !== hf[k]);
            if (bothExposure) {
              pushFrameExposureConflict(local, hf, shotUid, shotId, remoteShotsByIdentity.get(shotUid) ?? null, ctx);
              // 曝光字段保持本机值并列待选定，但行级 rev 跟到他机，
              // 避免下一轮同设备交换时被误判为已同步而跳过
              next.rev = hf.rev;
              touched = true;
            } else {
              const takeRemote = newerByStampOrTime(local.exposureRev, hf.exposureRev, local.updatedAt, hf.updatedAt);
              if (takeRemote && EXPOSURE_KEYS.some((k) => local[k] !== hf[k])) {
                for (const k of EXPOSURE_KEYS) {
                  (next as Record<ExposureKey, unknown>)[k] = hf[k];
                }
                next.exposureRev = hf.exposureRev;
                touched = true;
              }
            }

            // 位移量：按 offsetRev / 更新时间取新
            if (local.propOffsetMm !== hf.propOffsetMm) {
              const takeRemote = newerByStampOrTime(local.offsetRev, hf.offsetRev, local.updatedAt, hf.updatedAt);
              if (takeRemote) {
                next.propOffsetMm = hf.propOffsetMm;
                next.offsetRev = hf.offsetRev;
                touched = true;
              }
            }

            // 备注：按更新时间取新
            if (hf.updatedAt > local.updatedAt && local.note !== hf.note) {
              next.note = hf.note;
              touched = true;
            }

            if (touched) {
              next.updatedAt = Math.max(local.updatedAt, hf.updatedAt);
              next.rev = hf.rev;
              report.updated.frames += 1;
            } else {
              report.skipped.frames += 1;
            }
            merged.push({ row: next, rank: 0, remoteOrder: order });
          });

          // 本地独有帧（他机包没有）：保持原帧号，同帧号时排在骨架之后
          for (const lf of locals) {
            if (remoteFrameUids.has(lf.syncUid)) continue;
            merged.push({ row: { ...lf }, rank: 1, remoteOrder: Number.MAX_SAFE_INTEGER });
          }

          // 稳定排序：按帧号，同帧号骨架帧在前，再压缩重编号
          merged.sort((a, b) => a.row.frameNo - b.row.frameNo || a.rank - b.rank || a.remoteOrder - b.remoteOrder);
          const orderedRows = merged.map((m, idx) => ({ ...m.row, frameNo: idx + 1, shotId }));

          // 帧序是否变化（按 syncUid 序列对比）
          const beforeSeq = locals.slice().sort((a, b) => a.frameNo - b.frameNo).map((f) => f.syncUid).join('|');
          const afterSeq = orderedRows.map((f) => f.syncUid).join('|');
          const orderChanged = beforeSeq !== afterSeq;
          if (orderChanged) frameOrderChangedShots.add(shotUid);

          // 整段替换该镜头帧（保留他机/本机戳记，导入不经本机盖戳）
          await db.frames.where('shotId').equals(shotId).delete();
          if (orderedRows.length) await db.frames.bulkAdd(orderedRows.map((r) => toPlain(r)));
        }

        /* ----- 道具：按 syncUid 并入；帧区间两边都改 → 并列；区间失效 → 待整理 ----- */
        for (const hp of pkgInput.props) {
          const shotId = localIdByUid.get(hp.shotSyncUid);
          if (typeof shotId !== 'number') {
            await orphanProp(hp, ctx);
            continue;
          }
          const existing = localProps.find((p) => p.syncUid === hp.syncUid && p.shotId === shotId);
          if (!existing) {
            const frameCount = await db.frames.where('shotId').equals(shotId).count();
            const stale = hp.toFrame > frameCount;
            const row: PropState = {
              name: hp.name,
              shotId,
              fromFrame: hp.fromFrame,
              toFrame: hp.toFrame,
              posX: hp.posX,
              posY: hp.posY,
              posZ: hp.posZ,
              rotation: hp.rotation,
              fixation: hp.fixation as PropState['fixation'],
              updatedAt: hp.updatedAt,
              syncUid: hp.syncUid,
              rev: hp.rev,
              rangeRev: hp.rangeRev,
              posRev: hp.posRev,
              pendingTag: stale ? 'frame-order-stale' : null,
            };
            await db.props.add(toPlain(row));
            report.imported.props += 1;
            if (stale) {
              pushStaleProp(row, hp.shotSyncUid, shotId, remoteShotsByIdentity.get(hp.shotSyncUid) ?? null, ctx, '他机道具区间超出当前帧序');
            }
            continue;
          }

          if (sameDeviceStale(existing.rev, hp.rev)) {
            report.skipped.props += 1;
            continue;
          }

          const next: PropState = { ...existing };
          let touched = false;

          // 帧区间：两边都改过 → 并列，本机不动
          const bothRange =
            !!existing.rangeRev?.deviceId &&
            !!hp.rangeRev?.deviceId &&
            existing.rangeRev.deviceId !== hp.rangeRev.deviceId &&
            (existing.fromFrame !== hp.fromFrame || existing.toFrame !== hp.toFrame);
          if (bothRange) {
            pushPropRangeConflict(existing, hp, hp.shotSyncUid, shotId, remoteShotsByIdentity.get(hp.shotSyncUid) ?? null, ctx);
            // 区间保持本机值并列待选定，行级 rev 跟到他机，避免后续增量被误跳
            next.rev = hp.rev;
            touched = true;
          } else {
            const takeRange = newerByStampOrTime(existing.rangeRev, hp.rangeRev, existing.updatedAt, hp.updatedAt);
            if (takeRange && (existing.fromFrame !== hp.fromFrame || existing.toFrame !== hp.toFrame)) {
              next.fromFrame = hp.fromFrame;
              next.toFrame = hp.toFrame;
              next.rangeRev = hp.rangeRev;
              touched = true;
            }
          }

          // 位置/旋转：按 posRev / 更新时间取新
          const posKeys = ['posX', 'posY', 'posZ', 'rotation'] as const;
          type PosKey = (typeof posKeys)[number];
          const takePos = newerByStampOrTime(existing.posRev, hp.posRev, existing.updatedAt, hp.updatedAt);
          if (takePos && posKeys.some((k) => existing[k] !== hp[k])) {
            posKeys.forEach((k) => {
              (next as Record<PosKey, unknown>)[k] = hp[k];
            });
            next.posRev = hp.posRev;
            touched = true;
          }
          if (existing.name !== hp.name && hp.updatedAt > existing.updatedAt) {
            next.name = hp.name;
            touched = true;
          }
          if (existing.fixation !== hp.fixation && hp.updatedAt > existing.updatedAt) {
            next.fixation = hp.fixation as PropState['fixation'];
            touched = true;
          }

          // 帧序变化后区间失效：标记待整理（即便区间值已被他机更新过也要再检查）
          const frameCount = await db.frames.where('shotId').equals(shotId).count();
          const stale = next.toFrame > frameCount;
          next.pendingTag = stale ? 'frame-order-stale' : existing.pendingTag;

          if (touched || stale) {
            next.updatedAt = Math.max(existing.updatedAt, hp.updatedAt);
            next.rev = hp.rev;
            if (typeof existing.id !== 'number') {
              report.skipped.props += 1;
            } else {
              await db.props.update(existing.id, toPlain({ ...snapshotOf(next as unknown as Record<string, unknown>) }));
              report.updated.props += 1;
              if (stale) {
                pushStaleProp(next, hp.shotSyncUid, shotId, remoteShotsByIdentity.get(hp.shotSyncUid) ?? null, ctx, '帧序变化后道具区间超出当前帧序，轨迹需重算');
              }
            }
          } else {
            report.skipped.props += 1;
          }
        }

        /* ----- 实拍：同一条（syncUid）天然去重，不同条直接并入，重算剩余 ----- */
        const addedTakeUids = new Set<string>();
        for (const ht of pkgInput.takes) {
          const shotId = localIdByUid.get(ht.shotSyncUid);
          if (typeof shotId !== 'number') {
            await orphanTake(ht, ctx);
            continue;
          }
          const exists = localTakes.some((t) => t.syncUid === ht.syncUid) || addedTakeUids.has(ht.syncUid);
          if (exists) {
            report.skipped.takes += 1;
            continue;
          }
          const row: TakeLog = {
            date: ht.date,
            shotCode: ht.shotCode,
            shotId,
            takenFrames: ht.takenFrames,
            wastedFrames: ht.wastedFrames,
            remainingFrames: ht.remainingFrames,
            percent: ht.percent,
            updatedAt: ht.updatedAt,
            syncUid: ht.syncUid,
            rev: ht.rev,
            pendingTag: null,
          };
          await db.takes.add(toPlain(row));
          addedTakeUids.add(ht.syncUid);
          report.imported.takes += 1;
        }

        /* ----- 帧序变化：同步镜头区间/时长，重算实拍剩余张数与完成度 ----- */
        for (const shotUid of frameOrderChangedShots) {
          const shotId = localIdByUid.get(shotUid);
          if (typeof shotId !== 'number') continue;
          const shot = await db.shots.get(shotId);
          if (!shot) continue;
          const count = Math.max(1, await db.frames.where('shotId').equals(shotId).count());
          const fps = shot.fps || 24;
          const durationSec = Math.round((count / fps) * 1000) / 1000;
          await db.shots.update(shotId, toPlain({
            durationSec,
            endFrame: shot.startFrame + count - 1,
            updatedAt: Date.now(),
          }));
        }

        // 重算受影响镜头的实拍剩余张数与完成度（帧序变化镜头 + 有新实拍的镜头）
        const affectedShotIds = new Set<number>();
        for (const uid of frameOrderChangedShots) {
          const id = localIdByUid.get(uid);
          if (typeof id === 'number') affectedShotIds.add(id);
        }
        for (const ht of pkgInput.takes) {
          const id = localIdByUid.get(ht.shotSyncUid);
          if (typeof id === 'number') affectedShotIds.add(id);
        }
        for (const shotId of affectedShotIds) {
          await recalcShotProgress(shotId);
        }

        /* ----- 落待整理条目 ----- */
        if (ctx.pending.length) await db.pending.bulkAdd(ctx.pending.map((p) => toPlain(p)));
        report.conflicts = ctx.pending.filter((p) => p.kind === 'conflict').length;
        report.orphans = ctx.pending.filter((p) => p.kind === 'orphan').length;
        report.pendingTotal = await db.pending.count();

        // 他机包带回本机已发顺序号时抬高水位，避免回绕
        bumpWatermarkFromPkg(pkgInput);

        report.frameOrderChanged = [...frameOrderChangedShots]
          .map((uid) => remoteShotsByIdentity.get(uid)?.code ?? localShotByUid.get(uid)?.code ?? uid)
          .filter(Boolean);
        report.ok = true;
      },
    );
  } catch (e) {
    // 事务已回滚：原记录完整保留，允许重试
    report.ok = false;
    report.reason = 'unknown';
    report.message = e instanceof Error ? `导入失败已回滚：${e.message}，原记录保留，可重试` : '导入失败已回滚，原记录保留，可重试';
    return report;
  }

  return report;
}

/* ---------------- 待整理记录构造 ---------------- */

async function recalcShotProgress(shotId: number): Promise<void> {
  const shot = await db.shots.get(shotId);
  if (!shot) return;
  const planned = durationToFrames(shot.durationSec, shot.fps);
  const rows = await db.takes.where('shotId').equals(shotId).toArray();
  const taken = rows.reduce((s, r) => s + (r.takenFrames || 0), 0);
  const remaining = Math.max(0, planned - taken);
  const percent = Math.min(100, Math.round((taken / Math.max(1, planned)) * 100));
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
  // 同步最新一条实拍记录上的剩余张数快照
  if (rows.length) {
    const latest = rows.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)))[0];
    if (latest && typeof latest.id === 'number') {
      await db.takes.update(latest.id, toPlain({ remainingFrames: remaining, percent, updatedAt: latest.updatedAt }));
    }
  }
}

function pendingKey(kind: string, subject: string, syncUid: string): string {
  return `${kind}:${subject}:${syncUid}`;
}

function addPendingOnce(ctx: MergeContext, entry: PendingEntry): boolean {
  const key = pendingKey(entry.kind, entry.subject, entry.syncUid);
  if (ctx.pendingKeys.has(key)) return false;
  ctx.pendingKeys.add(key);
  ctx.pending.push(entry);
  return true;
}

function remoteShotBrief(hs: HandoverShot | null) {  if (!hs) return null;
  return {
    syncUid: hs.syncUid,
    code: hs.code,
    sceneName: hs.sceneName,
    fps: hs.fps,
    durationSec: hs.durationSec,
    startFrame: hs.startFrame,
    status: hs.status,
    owner: hs.owner,
  };
}

function pushFrameExposureConflict(
  local: FrameEntry,
  hf: HandoverFrame,
  shotUid: string,
  shotId: number,
  hs: HandoverShot | null,
  ctx: MergeContext,
): void {
  const shotCode = hs?.code ?? '';
  const { id: _id, ...localSnap } = local;
  void _id;
  addPendingOnce(ctx, {
    kind: 'conflict',
    entityType: 'frame',
    title: `第 ${hf.frameNo} 帧曝光参数两边都改过`,
    subject: 'frame-exposure',
    shotId,
    shotCode,
    syncUid: hf.syncUid,
    local: snapshotOf(localSnap as unknown as Record<string, unknown>),
    remote: { ...hf },
    remoteDeviceId: hf.rev.deviceId,
    remoteDeviceName: ctx.remoteDeviceName,
    remoteRev: hf.exposureRev,
    localRev: local.exposureRev,
    remoteShot: remoteShotBrief(hs),
    detail: `镜号 ${shotCode || shotUid}：本机保留当前曝光，他机版本并列待选定（曝光时间/光圈/ISO/快门角/张数/灯光至少一项不同）`,
    createdAt: Date.now(),
  });
}

function pushPropRangeConflict(
  local: PropState,
  hp: HandoverProp,
  shotUid: string,
  shotId: number,
  hs: HandoverShot | null,
  ctx: MergeContext,
): void {
  const shotCode = hs?.code ?? '';
  const { id: _id, ...localSnap } = local;
  void _id;
  void shotUid;
  addPendingOnce(ctx, {
    kind: 'conflict',
    entityType: 'prop',
    title: `道具「${hp.name}」帧区间两边都改过`,
    subject: 'prop-range',
    shotId,
    shotCode,
    syncUid: hp.syncUid,
    local: snapshotOf(localSnap as unknown as Record<string, unknown>),
    remote: { ...hp },
    remoteDeviceId: hp.rev.deviceId,
    remoteDeviceName: ctx.remoteDeviceName,
    remoteRev: hp.rangeRev,
    localRev: local.rangeRev,
    remoteShot: remoteShotBrief(hs),
    detail: `镜号 ${shotCode}：本机区间 ${local.fromFrame}–${local.toFrame}，他机区间 ${hp.fromFrame}–${hp.toFrame}，本机保留，他机版本并列待选定`,
    createdAt: Date.now(),
  });
}

function pushStaleProp(
  row: PropState,
  shotUid: string,
  shotId: number,
  hs: HandoverShot | null,
  ctx: MergeContext,
  detail: string,
): void {
  const { id: _id, ...snap } = row;
  void _id;
  void shotUid;
  addPendingOnce(ctx, {
    kind: 'orphan',
    entityType: 'prop',
    title: `道具「${row.name}」区间 ${row.fromFrame}–${row.toFrame} 找不到落点`,
    subject: 'prop-stale',
    shotId,
    shotCode: hs?.code ?? '',
    syncUid: row.syncUid,
    local: snapshotOf(snap as unknown as Record<string, unknown>),
    remote: snapshotOf(snap as unknown as Record<string, unknown>),
    remoteDeviceId: row.rev.deviceId,
    remoteDeviceName: ctx.remoteDeviceName,
    remoteRev: row.rangeRev,
    localRev: row.rangeRev,
    remoteShot: remoteShotBrief(hs),
    detail,
    createdAt: Date.now(),
  });
}

async function orphanFrame(hf: HandoverFrame, ctx: MergeContext): Promise<void> {
  if ((await db.frames.where('shotId').equals(-1).toArray()).some((f) => f.syncUid === hf.syncUid)) {
    ctx.report.skipped.frames += 1;
    return;
  }
  const row: FrameEntry = {
    frameNo: hf.frameNo,
    shotId: -1,
    shotCount: hf.shotCount as FrameEntry['shotCount'],
    exposureSec: hf.exposureSec,
    aperture: hf.aperture,
    iso: hf.iso,
    shutterAngle: hf.shutterAngle,
    lighting: hf.lighting,
    propOffsetMm: hf.propOffsetMm,
    note: hf.note,
    updatedAt: hf.updatedAt,
    syncUid: hf.syncUid,
    rev: hf.rev,
    exposureRev: hf.exposureRev,
    offsetRev: hf.offsetRev,
    pendingTag: 'orphan',
  };
  await db.frames.add(toPlain(row));
  ctx.report.imported.frames += 1;
  addPendingOnce(ctx, {
    kind: 'orphan',
    entityType: 'frame',
    title: `他机第 ${hf.frameNo} 帧找不到所属镜头`,
    subject: 'orphan-frame',
    shotId: -1,
    shotCode: '',
    syncUid: hf.syncUid,
    local: null,
    remote: { ...hf },
    remoteDeviceId: hf.rev.deviceId,
    remoteDeviceName: ctx.remoteDeviceName,
    remoteRev: hf.rev,
    localRev: null,
    remoteShot: null,
    detail: '交接包中的帧引用了不存在的镜头，已保留为待整理，可手动挂到镜头',
    createdAt: Date.now(),
  });
}

async function orphanProp(hp: HandoverProp, ctx: MergeContext): Promise<void> {
  if ((await db.props.where('shotId').equals(-1).toArray()).some((p) => p.syncUid === hp.syncUid)) {
    ctx.report.skipped.props += 1;
    return;
  }
  const row: PropState = {
    name: hp.name,
    shotId: -1,
    fromFrame: hp.fromFrame,
    toFrame: hp.toFrame,
    posX: hp.posX,
    posY: hp.posY,
    posZ: hp.posZ,
    rotation: hp.rotation,
    fixation: hp.fixation as PropState['fixation'],
    updatedAt: hp.updatedAt,
    syncUid: hp.syncUid,
    rev: hp.rev,
    rangeRev: hp.rangeRev,
    posRev: hp.posRev,
    pendingTag: 'orphan',
  };
  await db.props.add(toPlain(row));
  ctx.report.imported.props += 1;
  addPendingOnce(ctx, {
    kind: 'orphan',
    entityType: 'prop',
    title: `他机道具「${hp.name}」找不到所属镜头`,
    subject: 'orphan-prop',
    shotId: -1,
    shotCode: '',
    syncUid: hp.syncUid,
    local: null,
    remote: { ...hp },
    remoteDeviceId: hp.rev.deviceId,
    remoteDeviceName: ctx.remoteDeviceName,
    remoteRev: hp.rev,
    localRev: null,
    remoteShot: null,
    detail: '交接包中的道具引用了不存在的镜头，已保留为待整理，可手动挂到镜头',
    createdAt: Date.now(),
  });
}

async function orphanTake(ht: HandoverTake, ctx: MergeContext): Promise<void> {
  if ((await db.takes.where('shotId').equals(-1).toArray()).some((t) => t.syncUid === ht.syncUid)) {
    ctx.report.skipped.takes += 1;
    return;
  }
  const row: TakeLog = {
    date: ht.date,
    shotCode: ht.shotCode,
    shotId: -1,
    takenFrames: ht.takenFrames,
    wastedFrames: ht.wastedFrames,
    remainingFrames: ht.remainingFrames,
    percent: ht.percent,
    updatedAt: ht.updatedAt,
    syncUid: ht.syncUid,
    rev: ht.rev,
    pendingTag: 'orphan',
  };
  await db.takes.add(toPlain(row));
  ctx.report.imported.takes += 1;
  addPendingOnce(ctx, {
    kind: 'orphan',
    entityType: 'take',
    title: `他机实拍记录 ${ht.date}（${ht.shotCode}）找不到所属镜头`,
    subject: 'orphan-take',
    shotId: -1,
    shotCode: ht.shotCode,
    syncUid: ht.syncUid,
    local: null,
    remote: { ...ht },
    remoteDeviceId: ht.rev.deviceId,
    remoteDeviceName: ctx.remoteDeviceName,
    remoteRev: ht.rev,
    localRev: null,
    remoteShot: null,
    detail: '交接包中的实拍记录引用了不存在的镜头，已保留为待整理，可手动挂到镜头',
    createdAt: Date.now(),
  });
}
