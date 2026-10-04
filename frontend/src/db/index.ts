/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加交接能力：frames/props/takes 补 uid/rev/lastChange 交接字段，
 *      新增 handoff_ops（已应用操作日志，按设备+顺序号去重）与 pending（待整理）表。
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { HandOpLogRow, PendingItem } from '../handoff/dbTypes';
import { newUid } from '../handoff/uid';

export const DB_NAME = 'gbstopmotion-db';

/** 升级迁移用的本机设备标识（v4 补齐旧数据的 lastChange 来源） */
const LEGACY_DEVICE = 'legacy-upgrade';

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
  handoffOps!: Table<HandOpLogRow, number>;
  pending!: Table<PendingItem, number>;

  constructor() {
    super(DB_NAME);
    // null 表声明：让 Dexie 在升级时「承认」旧版本里已存在但当时未纳管的表，
    // 避免 v2/v3/v4 加表时把旧库里同名的手工 / 其他客户端创建的表重建清空。
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
      props: null,
      takes: null,
      handoffOps: null,
      pending: null,
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: null,
        handoffOps: null,
        pending: null,
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
        handoffOps: null,
        pending: null,
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
        frames: '++id, shotId, frameNo, uid, [shotId+frameNo]',
        props: '++id, shotId, name, uid, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode, uid',
        // 已应用操作按 (deviceId, seq) 去重 / 判缺口；待整理按镜号与原因检索
        handoffOps: '++id, [deviceId+seq], deviceId, shotCode',
        pending: '++id, shotCode, reason, refUid',
      })
      .upgrade(async (tx) => {
        // v4：旧数据补齐交接字段，原有页面照常工作
        const backfill = (row: Record<string, unknown>) => {
          if (typeof row.uid !== 'string' || !row.uid) row.uid = newUid();
          if (typeof row.rev !== 'number') row.rev = 1;
          if (!row.lastChange || typeof row.lastChange !== 'object') {
            row.lastChange = { deviceId: LEGACY_DEVICE, seq: 1 };
          }
        };
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            backfill(row);
            if (row.trajectory !== 'stale') row.trajectory = 'ok';
          });
        await tx
          .table('props')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            backfill(row);
            if (row.trajectory !== 'stale') row.trajectory = 'ok';
          });
        await tx.table('takes').toCollection().modify(backfill);
      });
  }
}

export const db = new StopMotionDb();
