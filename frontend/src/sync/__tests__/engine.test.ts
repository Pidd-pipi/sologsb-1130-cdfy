/**
 * 交接引擎端到端测试：用 fake-indexeddb 模拟两台离线机器的本地库，
 * 走「基线导出 → 各自离线改动 → 回网合并」的完整链路。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../../db';
import * as api from '../../db/api';
import {
  buildHandoverPackage,
  ensureCapacity,
  mergeHandover,
  packageItemCount,
  parseHandoverText,
} from '../engine';
import {
  attachOrphanToShot,
  discardPending,
  resolveWithLocal,
  resolveWithRemote,
} from '../resolve';
import { __resetDeviceForTest, currentSeq } from '../../utils/device';
import { createEmptyShot } from '../../types/shot';
import { createEmptyFrame } from '../../types/frame';
import { createEmptyProp } from '../../types/prop';
import { createEmptyTake } from '../../types/take';
import type { HandoverPackage } from '../../types/sync';
import { EMPTY_REV } from '../../types/sync';

async function resetWorld(deviceId: string, name: string) {
  db.close();
  await db.delete();
  await db.open();
  __resetDeviceForTest(deviceId, name);
}

async function seedShot(code: string, frameCount: number) {
  const id = await api.addShot({
    ...createEmptyShot(),
    code,
    sceneName: '棚内夜景',
    fps: 24,
    durationSec: Math.round((frameCount / 24) * 1000) / 1000,
    startFrame: 1,
    endFrame: frameCount,
  });
  await api.addFrames(Array.from({ length: frameCount }, (_, i) => ({ ...createEmptyFrame(id, i + 1) })));
  await api.addProp({ ...createEmptyProp(id), name: '小车', fromFrame: 1, toFrame: frameCount });
  return id;
}

function rev(device: string, seq: number) {
  return { deviceId: device, seq };
}

async function counts() {
  return {
    shots: await db.shots.count(),
    frames: await db.frames.count(),
    props: await db.props.count(),
    takes: await db.takes.count(),
    pending: await db.pending.count(),
  };
}

beforeEach(async () => {
  await resetWorld('device-A', 'A机');
});

afterEach(() => {
  const g = globalThis as unknown as { navigator?: unknown };
  if (g.navigator) delete (g as { navigator?: unknown }).navigator;
});

describe('设备标识与顺序号', () => {
  it('本机写入自动带设备标识和递增顺序号', async () => {
    const id = await seedShot('S01', 3);
    const shot = await db.shots.get(id);
    expect(shot?.syncUid).toBeTruthy();
    expect(shot?.rev.deviceId).toBe('device-A');
    expect(shot?.rev.seq).toBeGreaterThan(0);
    const seqAfterShot = currentSeq();

    const frames = await api.listFrames(id);
    await api.updateFrame(frames[0].id!, { exposureSec: 1 });
    const updated = await db.frames.get(frames[0].id!);
    expect(updated?.exposureRev.deviceId).toBe('device-A');
    // 只改曝光，顺序号继续递增
    expect(updated?.exposureRev.seq).toBeGreaterThan(seqAfterShot);
    expect(updated?.offsetRev.seq).toBe(frames[0].offsetRev.seq);
  });

  it('纯帧号重排不推进修订戳', async () => {
    const id = await seedShot('S01', 3);
    const before = (await api.listFrames(id)).map((f) => ({ uid: f.syncUid, rev: f.rev.seq }));
    const reordered = (await api.listFrames(id)).slice();
    const [first] = reordered.splice(0, 1);
    reordered.push(first);
    await api.replaceShotFrames(id, reordered.map((f, i) => ({ ...f, frameNo: i + 1 })));
    const after = (await api.listFrames(id)).map((f) => ({ uid: f.syncUid, rev: f.rev.seq }));
    const beforeMap = new Map(before.map((b) => [b.uid, b.rev]));
    for (const a of after) expect(a.rev).toBe(beforeMap.get(a.uid));
  });
});

describe('双机离线合并', () => {
  it('不同帧/道具/实拍直接并入；同帧曝光与道具区间两边都改时并列保留、本机不动', async () => {
    // ---- 基线在 A 机，导出 ----
    const shotIdA = await seedShot('S01', 4);
    const baseText = (await buildHandoverPackage()).text;

    // ---- B 机拿到基线，离线改动 ----
    await resetWorld('device-B', 'B机');
    await mergeHandover(parseHandoverText(baseText));
    let bFrames = await api.listFrames(1);
    const bProps = await api.listProps(1);
    // B 改第 1 帧曝光、改道具区间起点
    await api.updateFrame(bFrames[0].id!, { exposureSec: 0.5, aperture: 8 });
    await api.updateProp(bProps[0].id!, { fromFrame: 2 });
    // B 移动帧序并新增一帧
    bFrames = await api.listFrames(1);
    const moved = bFrames.slice();
    const [head] = moved.splice(0, 1);
    moved.splice(2, 0, head);
    moved.splice(2, 0, { ...createEmptyFrame(1, 1), note: 'B机新帧' });
    await api.replaceShotFrames(1, moved.map((f, i) => ({ ...f, frameNo: i + 1 })));
    // B 登记实拍
    await api.addTake({ ...createEmptyTake(1, 'S01'), date: '2026-10-03', takenFrames: 2, wastedFrames: 0 });
    const packageB = (await buildHandoverPackage()).text;

    // ---- A 机也在离线改动同一帧曝光与同一道具区间 ----
    await resetWorld('device-A', 'A机');
    await mergeHandover(parseHandoverText(baseText));
    let aFrames = await api.listFrames(1);
    const aProps = await api.listProps(1);
    await api.updateFrame(aFrames[0].id!, { exposureSec: 0.016, aperture: 2.8 });
    await api.updateProp(aProps[0].id!, { toFrame: 3 });
    aFrames = await api.listFrames(1);
    await api.replaceShotFrames(1, [...aFrames, { ...createEmptyFrame(1, aFrames.length + 1), note: 'A机新帧' }].map((f, i) => ({ ...f, frameNo: i + 1 })));
    await api.addTake({ ...createEmptyTake(1, 'S01'), date: '2026-10-04', takenFrames: 1, wastedFrames: 0 });
    const beforeMerge = await counts();

    // ---- A 机导入 B 包 ----
    const report = await mergeHandover(parseHandoverText(packageB));
    expect(report.ok).toBe(true);
    expect(report.conflicts).toBe(2);
    expect(report.frameOrderChanged).toContain('S01');

    // 本机原有记录数不变（冲突没有覆盖本机），并多了 B 机新增的帧
    const afterMerge = await counts();
    expect(afterMerge.frames - beforeMerge.frames).toBe(1);
    expect(afterMerge.takes - beforeMerge.takes).toBe(1);
    expect(afterMerge.pending).toBe(2);

    // 同一帧曝光：本机值保持
    const aFrame1 = (await api.listFrames(1)).find((f) => f.syncUid === aFrames[0].syncUid)!;
    expect(aFrame1.exposureSec).toBe(0.016);
    expect(aFrame1.aperture).toBe(2.8);

    // 同一道具区间：本机值保持
    const prop = (await api.listProps(1))[0];
    expect(prop.fromFrame).toBe(1);
    expect(prop.toFrame).toBe(3);

    // B 机新帧并入、帧序按 B 机骨架排列（B 先把原首帧挪到第 3 位，再在第 3 位插帧）
    const mergedFrames = await api.listFrames(1);
    expect(mergedFrames).toHaveLength(6);
    expect(mergedFrames.find((f) => f.note === 'B机新帧')).toBeTruthy();
    expect(mergedFrames.find((f) => f.note === 'A机新帧')).toBeTruthy();
    expect(mergedFrames[3].syncUid).toBe(aFrames[0].syncUid);

    // 实拍剩余张数随帧序变化同步重算：6 帧 - 3 张 = 3，完成 50%
    const shot = await db.shots.get(1);
    expect(shot?.endFrame).toBe(6);
    expect(shot?.progressPercent).toBe(50);
    const takes = (await api.listTakesByShot(1)).sort((x, y) => x.date.localeCompare(y.date));
    expect(takes).toHaveLength(2);
    expect(takes[takes.length - 1].remainingFrames).toBe(3);

    // ---- 重复导入同一包：幂等，不新增冲突/数据 ----
    const report2 = await mergeHandover(parseHandoverText(packageB));
    expect(report2.ok).toBe(true);
    expect(await db.pending.count()).toBe(2);
    expect(await db.frames.count()).toBe(6);
    expect(await db.takes.count()).toBe(2);

    // ---- 选定前本机未动；选定他机后曝光改为 B 值，待整理清除 ----
    const pending = await api.listPending();
    const frameConflict = pending.find((p) => p.subject === 'frame-exposure')!;
    await resolveWithRemote(frameConflict);
    const resolved = (await api.listFrames(1)).find((f) => f.syncUid === aFrames[0].syncUid)!;
    expect(resolved.exposureSec).toBe(0.5);
    expect(resolved.aperture).toBe(8);
    expect(await db.pending.count()).toBe(1);

    // 道具冲突选本机：仅清待整理，区间仍是本机值
    const propConflict = (await api.listPending()).find((p) => p.subject === 'prop-range')!;
    await resolveWithLocal(propConflict);
    const propAfter = (await api.listProps(1))[0];
    expect(propAfter.fromFrame).toBe(1);
    expect(propAfter.toFrame).toBe(3);
    expect(await db.pending.count()).toBe(0);
  });

  it('找不到镜头的条目标待整理，可挂到镜头或丢弃', async () => {
    await seedShot('S09', 3);
    const orphanPkg: HandoverPackage = {
      format: 'gbstopmotion-handover',
      version: 1,
      deviceId: 'device-B',
      deviceName: 'B机',
      exportedAt: Date.now(),
      shots: [],
      frames: [
        {
          syncUid: 'orphan-frame-1',
          shotSyncUid: 'missing-shot',
          frameNo: 1,
          shotCount: 2,
          exposureSec: 0.25,
          aperture: 5.6,
          iso: 200,
          shutterAngle: 180,
          lighting: '主灯',
          propOffsetMm: 0,
          note: '',
          updatedAt: Date.now(),
          rev: rev('device-B', 9),
          exposureRev: rev('device-B', 9),
          offsetRev: rev('device-B', 9),
          pendingTag: null,
        },
      ],
      props: [
        {
          syncUid: 'orphan-prop-1',
          shotSyncUid: 'missing-shot',
          name: '云片',
          fromFrame: 1,
          toFrame: 2,
          posX: 0,
          posY: 0,
          posZ: 0,
          rotation: 0,
          fixation: '支架',
          updatedAt: Date.now(),
          rev: rev('device-B', 10),
          rangeRev: rev('device-B', 10),
          posRev: rev('device-B', 10),
          pendingTag: null,
        },
      ],
      takes: [
        {
          syncUid: 'orphan-take-1',
          shotSyncUid: 'missing-shot',
          date: '2026-10-02',
          shotCode: 'SXX',
          takenFrames: 1,
          wastedFrames: 0,
          remainingFrames: 0,
          percent: 0,
          updatedAt: Date.now(),
          rev: rev('device-B', 11),
          pendingTag: null,
        },
      ],
    };

    const report = await mergeHandover(orphanPkg);
    expect(report.ok).toBe(true);
    expect(report.orphans).toBe(3);
    // 原镜头数据不受影响；孤儿行以 shotId=-1 保留
    expect(await db.frames.where('shotId').equals(-1).count()).toBe(1);
    expect(await db.props.where('shotId').equals(-1).count()).toBe(1);
    expect(await db.takes.where('shotId').equals(-1).count()).toBe(1);

    // 帧挂到 S09：排到帧序末尾并重算区间
    const pending = await api.listPending();
    const framePending = pending.find((p) => p.subject === 'orphan-frame')!;
    const before = await api.listFrames(1);
    await attachOrphanToShot(framePending, 1);
    const after = await api.listFrames(1);
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1].syncUid).toBe('orphan-frame-1');
    expect((await db.shots.get(1))?.endFrame).toBe(4);

    // 其余丢弃：业务行与待整理一起清除
    for (const p of await api.listPending()) await discardPending(p);
    expect(await db.pending.count()).toBe(0);
    expect(await db.props.where('shotId').equals(-1).count()).toBe(0);
    expect(await db.takes.where('shotId').equals(-1).count()).toBe(0);
  });
});

describe('容量与失败处理', () => {
  it('超过 1000 项且容量不足时拒绝导入，原记录保留', async () => {
    await seedShot('S01', 2);
    const before = await counts();

    const pkg: HandoverPackage = {
      format: 'gbstopmotion-handover',
      version: 1,
      deviceId: 'device-B',
      deviceName: 'B机',
      exportedAt: Date.now(),
      shots: [
        {
          syncUid: 'shot-big',
          code: 'S99',
          sceneName: '大镜头',
          fps: 24,
          durationSec: 100,
          startFrame: 1,
          endFrame: 1002,
          status: '拍摄中',
          owner: '',
          progressPercent: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          rev: rev('device-B', 1),
        },
      ],
      frames: Array.from({ length: 1001 }, (_, i) => ({
        syncUid: `big-frame-${i}`,
        shotSyncUid: 'shot-big',
        frameNo: i + 1,
        shotCount: 2 as const,
        exposureSec: 0.25,
        aperture: 5.6,
        iso: 200,
        shutterAngle: 180,
        lighting: '主灯',
        propOffsetMm: 0,
        note: '',
        updatedAt: Date.now(),
        rev: rev('device-B', 2),
        exposureRev: rev('device-B', 2),
        offsetRev: rev('device-B', 2),
        pendingTag: null,
      })),
      props: [],
      takes: [],
    };
    expect(packageItemCount(pkg)).toBeGreaterThan(1000);
    expect((await ensureCapacity(pkg)).ok).toBe(true); // node 无 estimate 时不拦

    (globalThis as unknown as { navigator: unknown }).navigator = {
      storage: { estimate: async () => ({ quota: 1024, usage: 0 }) },
    };
    const cap = await ensureCapacity(pkg);
    expect(cap.ok).toBe(false);

    const report = await mergeHandover(pkg);
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('capacity');
    expect(await counts()).toEqual(before);
  });

  it('导入中途失败时事务回滚、原记录保留，恢复后可重试成功', async () => {
    await seedShot('S01', 2);
    const shotUid = (await db.shots.toArray())[0].syncUid;

    const pkg: HandoverPackage = {
      format: 'gbstopmotion-handover',
      version: 1,
      deviceId: 'device-B',
      deviceName: 'B机',
      exportedAt: Date.now(),
      shots: [
        {
          syncUid: shotUid,
          code: 'S01',
          sceneName: '棚内夜景',
          fps: 24,
          durationSec: 1,
          startFrame: 1,
          endFrame: 4,
          status: '未开机',
          owner: '',
          progressPercent: 0,
          createdAt: Date.now(),
          updatedAt: Date.now() + 1000,
          rev: { ...EMPTY_REV },
        },
      ],
      frames: Array.from({ length: 3 }, (_, i) => ({
        syncUid: `retry-frame-${i}`,
        shotSyncUid: shotUid,
        frameNo: i + 1,
        shotCount: 2 as const,
        exposureSec: 0.25,
        aperture: 5.6,
        iso: 200,
        shutterAngle: 180,
        lighting: '主灯',
        propOffsetMm: 0,
        note: `重试帧${i}`,
        updatedAt: Date.now(),
        rev: rev('device-B', 100 + i),
        exposureRev: rev('device-B', 100 + i),
        offsetRev: rev('device-B', 100 + i),
        pendingTag: null,
      })),
      props: [],
      takes: [],
    };

    const before = await counts();
    const framesTable = db.frames as unknown as { bulkAdd: (...args: unknown[]) => Promise<unknown> };
    const original = framesTable.bulkAdd;
    framesTable.bulkAdd = async () => {
      throw new Error('模拟磁盘写入失败');
    };
    const failed = await mergeHandover(pkg);
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain('回滚');
    expect(await counts()).toEqual(before);

    // 恢复后重试成功
    framesTable.bulkAdd = original;
    const retry = await mergeHandover(pkg);
    expect(retry.ok).toBe(true);
    expect((await counts()).frames).toBe(before.frames + 3);
  });
});
