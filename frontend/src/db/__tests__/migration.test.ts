/**
 * v4 升级迁移：模拟 v3 老库（无 syncUid / 修订戳），打开新代码后自动补齐交接字段，
 * 原有页面的读写与计算不受影响。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, DB_NAME } from '../../db';

async function buildLegacyV3(): Promise<void> {
  db.close();
  await db.delete();
  const legacy = new Dexie(DB_NAME);
  legacy.version(1).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
  });
  legacy.version(2).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
    props: '++id, shotId, name, [shotId+fromFrame]',
  });
  legacy.version(3).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
    props: '++id, shotId, name, [shotId+fromFrame]',
    takes: '++id, shotId, date, shotCode',
  });
  await legacy.open();
  const shotId = await legacy.table('shots').add({
    code: 'S01',
    sceneName: '老镜头',
    fps: 24,
    durationSec: 1,
    startFrame: 1,
    endFrame: 24,
    status: '未开机',
    owner: '',
    progressPercent: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await legacy.table('frames').add({
    frameNo: 1,
    shotId,
    shotCount: 2,
    exposureSec: 0.25,
    aperture: 5.6,
    iso: 200,
    shutterAngle: 180,
    lighting: '主灯',
    propOffsetMm: 0,
    note: '',
    updatedAt: 1,
  });
  await legacy.table('props').add({
    name: '小车',
    shotId,
    fromFrame: 1,
    toFrame: 24,
    posX: 0,
    posY: 0,
    posZ: 0,
    rotation: 0,
    fixation: '支架',
    updatedAt: 1,
  });
  await legacy.table('takes').add({
    date: '2026-10-01',
    shotCode: 'S01',
    shotId,
    takenFrames: 4,
    wastedFrames: 0,
    remainingFrames: 20,
    percent: 17,
    updatedAt: 1,
  });
  legacy.close();
}

beforeEach(async () => {
  await buildLegacyV3();
});

describe('v3 → v4 旧数据升级', () => {
  it('旧行补齐 syncUid / 修订戳 / pendingTag，原有字段保留', async () => {
    await db.open(); // 触发 v4 upgrade
    const shots = await db.shots.toArray();
    const frames = await db.frames.toArray();
    const props = await db.props.toArray();
    const takes = await db.takes.toArray();

    expect(shots).toHaveLength(1);
    expect(shots[0].syncUid).toBeTruthy();
    expect(shots[0].rev).toEqual({ deviceId: '', seq: 0 });
    expect(shots[0].code).toBe('S01');

    expect(frames[0].syncUid).toBeTruthy();
    expect(frames[0].exposureRev).toEqual({ deviceId: '', seq: 0 });
    expect(frames[0].offsetRev).toEqual({ deviceId: '', seq: 0 });
    expect(frames[0].pendingTag).toBeNull();
    expect(frames[0].exposureSec).toBe(0.25);

    expect(props[0].syncUid).toBeTruthy();
    expect(props[0].rangeRev).toEqual({ deviceId: '', seq: 0 });
    expect(props[0].posRev).toEqual({ deviceId: '', seq: 0 });
    expect(props[0].name).toBe('小车');

    expect(takes[0].syncUid).toBeTruthy();
    expect(takes[0].rev).toEqual({ deviceId: '', seq: 0 });
    expect(takes[0].takenFrames).toBe(4);

    // pending 表建立成功
    expect(await db.pending.count()).toBe(0);
  });
});
