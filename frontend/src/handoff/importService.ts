/**
 * 交接包导入：解析 → 缺口 / 容量校验 → 单事务合并落库。
 *
 * - 超过 1000 项且合并后会超本机容量：拒绝导入，原记录原封不动（E_CAPACITY）。
 * - 任何落库错误：Dexie 事务整体回滚，原记录恢复，调用方可原样重试。
 * - 已应用的 (deviceId, seq) 幂等跳过；重试同一包不会重复叠加实拍。
 */
import { db, toPlain } from '../db';
import type { Table } from 'dexie';
import * as api from '../db/api';
import { getDeviceCapacity } from './device';
import { decodePackage } from './package';
import { detectGap, mergeHandoff, projectRowCounts, type MergeInput } from './merge';
import {
  HandoffError,
  LARGE_PACKAGE_OPS,
  type HandoffPackage,
  type ImportReport,
} from './types';
import type { HandOpLogRow } from './dbTypes';

/** 解析粘贴文本并返回预览（不落库） */
export function previewPackage(text: string): HandoffPackage {
  return decodePackage(text);
}

export async function importPackage(text: string): Promise<ImportReport> {
  const pkg = decodePackage(text);
  const operations = pkg.operations;

  const [shots, frames, props, takes, appliedKeys, existingPending] = await Promise.all([
    api.listShots(),
    api.listAllFrames(),
    api.listAllProps(),
    api.listTakes(),
    api.loadAppliedKeys(),
    api.listPending(),
  ]);

  const input: MergeInput = {
    shots,
    frames,
    props,
    takes,
    appliedKeys,
    existingPendingKeys: new Set(existingPending.map((p) => `${p.reason}:${p.refUid}`)),
  };

  // 顺序号缺口：拒绝整包，避免只并入一段导致轨迹 / 进度对不上
  const gap = detectGap(operations, appliedKeys);
  if (gap) throw new HandoffError('E_GAP', gap);

  // 大包容量门槛：超过 1000 项时，预估合并后总行数，超容量则拒绝并保留原记录
  if (operations.length > LARGE_PACKAGE_OPS) {
    const projected = projectRowCounts(input, operations, 0);
    const capacity = getDeviceCapacity();
    if (projected > capacity) {
      throw new HandoffError(
        'E_CAPACITY',
        `交接包含 ${operations.length} 项，预估导入后本机约 ${projected} 行，超过容量 ${capacity} 行，已拒绝导入并保留原记录。可在交接页调大容量后重试。`,
      );
    }
  }

  // 合并在纯函数内完成（此时库未被改动）；落库放进单事务，失败即整体回滚
  const outcome = mergeHandoff(input, operations);

  try {
    await db.transaction(
      'rw',
      [db.shots, db.frames, db.props, db.takes, db.pending, db.handoffOps],
      async () => {
        // 新镜头先落库拿到真实 id，再把合并结果里引用的临时负 id 全部换成真实 id
        const tempIdToReal = new Map<number, number>();
        for (const created of outcome.newShots) {
          const row = { ...created.shot, id: undefined };
          const realId = await db.shots.add(toPlain(row));
          tempIdToReal.set(created.tempId, realId);
        }
        const remap = (shotId: number) => (shotId < 0 ? tempIdToReal.get(shotId) ?? shotId : shotId);
        for (const f of outcome.frames) f.shotId = remap(f.shotId);
        for (const p of outcome.props) p.shotId = remap(p.shotId);
        for (const t of outcome.takes) t.shotId = remap(t.shotId);

        // 帧 / 道具 / 实拍：以 uid 对齐整表。
        // 合并输入是整表副本，且合并只增不删（本机多出的帧标待整理保留），
        // 所以结果里旧行都在，整表对齐不会误删本机数据。
        await syncTable(db.frames, outcome.frames);
        await syncTable(db.props, outcome.props);
        await syncTable(db.takes, outcome.takes);

        // 已有镜头回写被合并改动的字段（新镜头已在上一步落库）
        for (const shot of outcome.shots) {
          if (typeof shot.id !== 'number' || shot.id < 0) continue;
          const before = shots.find((s) => s.id === shot.id);
          if (
            before &&
            (before.sceneName !== shot.sceneName ||
              before.fps !== shot.fps ||
              before.startFrame !== shot.startFrame ||
              before.status !== shot.status ||
              before.owner !== shot.owner ||
              before.endFrame !== shot.endFrame ||
              before.durationSec !== shot.durationSec ||
              before.progressPercent !== shot.progressPercent ||
              before.updatedAt !== shot.updatedAt)
          ) {
            await db.shots.update(
              shot.id,
              toPlain({
                sceneName: shot.sceneName,
                fps: shot.fps,
                startFrame: shot.startFrame,
                status: shot.status,
                owner: shot.owner,
                endFrame: shot.endFrame,
                durationSec: shot.durationSec,
                progressPercent: shot.progressPercent,
                updatedAt: shot.updatedAt,
              }),
            );
          }
        }

        // 待整理：删除已被本次合并消解的旧项；与本次无关的旧项原样保留；新增项写入
        const existedPending = await db.pending.toArray();
        for (const key of outcome.resolvedPendingKeys) {
          const [reason, refUid] = splitPendingKey(key);
          const hit = existedPending.find((p) => p.reason === reason && p.refUid === refUid);
          if (hit && typeof hit.id === 'number') await db.pending.delete(hit.id);
        }
        const oldKeys = new Set(existedPending.map((p) => `${p.reason}:${p.refUid}`));
        const toAdd = outcome.pending.filter((p) => !oldKeys.has(`${p.reason}:${p.refUid}`));
        if (toAdd.length) await db.pending.bulkAdd(toAdd.map((p) => toPlain({ ...p, id: undefined })));

        // 操作日志：只追加本次新并入的操作（含完整 op，支持重试幂等与整包转发）
        const logRows: HandOpLogRow[] = outcome.newOps.map((op) => ({
          deviceId: op.deviceId,
          seq: op.seq,
          opType: op.op,
          shotCode: op.shotCode,
          appliedAt: Date.now(),
          op: toPlain(op),
        }));
        if (logRows.length) await db.handoffOps.bulkAdd(logRows);
      },
    );
  } catch (e) {
    // 事务已回滚 → 原记录保留；错误上浮，UI 可原样重试
    if (e instanceof HandoffError) throw e;
    throw new HandoffError('E_IMPORT', `导入落库失败，已恢复原记录，可重试：${(e as Error).message}`);
  }

  return { packageDeviceId: pkg.deviceId, ...outcome.report };
}

/** 整表按合并结果对齐：删掉结果里不存在的旧 id，再 bulkPut 其余行 */
function splitPendingKey(key: string): [string, string] {
  const idx = key.indexOf(':');
  return idx < 0 ? [key, ''] : [key.slice(0, idx), key.slice(idx + 1)];
}

async function syncTable<T extends { id?: number }>(
  table: Table<T, number>,
  rows: T[],
): Promise<void> {
  const keep = new Set(rows.filter((r) => typeof r.id === 'number').map((r) => r.id as number));
  const allIds = (await table.toCollection().primaryKeys()) as number[];
  const toDelete = allIds.filter((id) => !keep.has(id));
  if (toDelete.length) await table.bulkDelete(toDelete);
  if (rows.length) await table.bulkPut(rows.map((r) => toPlain(r)));
}
