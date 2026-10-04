/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加 pending（待整理）表，为旧数据补齐交接字段（syncUid / 修订戳），
 *      原有页面读写路径不变。
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { PendingEntry } from '../types/sync';
import { EMPTY_REV } from '../types/sync';
import { newSyncUid } from '../utils/device';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;
  pending!: Table<PendingEntry, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, pendingTag, [shotId+frameNo]',
        props: '++id, shotId, name, pendingTag, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode, pendingTag',
        pending: '++id, kind, entityType, shotId, syncUid, subject',
      })
      .upgrade(async (tx) => {
        // v4：旧数据补齐交接字段，原有页面照常工作。
        // syncUid 只在缺失时补；旧行的修订戳留空，合并时他机改动会作为新值直接并入。
        await tx
          .table('shots')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.syncUid !== 'string' || !row.syncUid) row.syncUid = newSyncUid();
            if (!row.rev || typeof row.rev !== 'object') row.rev = { ...EMPTY_REV };
          });
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.syncUid !== 'string' || !row.syncUid) row.syncUid = newSyncUid();
            if (!row.rev || typeof row.rev !== 'object') row.rev = { ...EMPTY_REV };
            if (!row.exposureRev || typeof row.exposureRev !== 'object') row.exposureRev = { ...EMPTY_REV };
            if (!row.offsetRev || typeof row.offsetRev !== 'object') row.offsetRev = { ...EMPTY_REV };
            if (row.pendingTag === undefined) row.pendingTag = null;
          });
        await tx
          .table('props')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.syncUid !== 'string' || !row.syncUid) row.syncUid = newSyncUid();
            if (!row.rev || typeof row.rev !== 'object') row.rev = { ...EMPTY_REV };
            if (!row.rangeRev || typeof row.rangeRev !== 'object') row.rangeRev = { ...EMPTY_REV };
            if (!row.posRev || typeof row.posRev !== 'object') row.posRev = { ...EMPTY_REV };
            if (row.pendingTag === undefined) row.pendingTag = null;
          });
        await tx
          .table('takes')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.syncUid !== 'string' || !row.syncUid) row.syncUid = newSyncUid();
            if (!row.rev || typeof row.rev !== 'object') row.rev = { ...EMPTY_REV };
            if (row.pendingTag === undefined) row.pendingTag = null;
          });
      });
  }
}

export const db = new StopMotionDb();
