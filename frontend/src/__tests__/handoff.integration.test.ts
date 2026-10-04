import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import * as api from '../db/api';
import { db } from '../db/index';
import { setDeviceCapacity, setDeviceName, resetDeviceState } from '../handoff/device';
import { exportHandoffText } from '../handoff/exportService';
import { importPackage } from '../handoff/importService';
import { decodePackage } from '../handoff/package';
import {
  ignorePending,
  resolveExposureConflict,
} from '../handoff/resolve';
import { editFrameExposure, addTakeTracked, addPropTracked, addShotTracked, replaceFrameOrder } from '../handoff/local';
import { HandoffError } from '../handoff/types';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';

before(() => {
  setDeviceName('排帧机A');
});

/**
 * 每个用例换新设备身份 + 新 Dexie 实例（delete() 后单例连接缓存会串数据，
 * 生产环境只在删库重建这种极端场景遇到，测试里直接热替换模块单例）。
 */
async function resetDb() {
  resetDeviceState();
  setDeviceName('排帧机A');
  await db.close();
  await db.delete();
  await db.open();
}

/** 只清库，不动本机设备身份（模拟「同一台机器」回到网络后的第二阶段） */
async function resetDataOnly() {
  await db.close();
  await db.delete();
  await db.open();
}

async function seedShot(code = 'S01', frameCount = 3): Promise<{ shot: Shot; frames: FrameEntry[] }> {
  const now = Date.now();
  const shotId = await addShotTracked({
    code,
    sceneName: '测试场景',
    fps: 24,
    durationSec: frameCount / 24,
    startFrame: 1,
    endFrame: frameCount,
    status: '拍摄中',
    owner: '',
    progressPercent: 0,
    createdAt: now,
    updatedAt: now,
  });
  const frames: FrameEntry[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const f = createEmptyFrame(shotId, i + 1);
    frames.push({ ...f });
  }
  // 首段帧序走 tracked 写入（等价于新建镜头后的首帧落库），保证包里带 frame.order
  await replaceFrameOrder(code, shotId, frames);
  const saved = await api.listFrames(shotId);
  const shot = (await api.getShot(shotId)) as Shot;
  return { shot, frames: saved };
}

test('端到端：本机编辑 → 出包 → 解码 → 导入后实拍张数 / 帧序 / 道具全部并入', async () => {
  await resetDb();
  setDeviceCapacity(50000);
  const { shot, frames } = await seedShot('S01', 3);

  // 本机操作：改曝光、登记实拍、加道具、帧序重排
  await editFrameExposure(shot.code, frames[0], { exposureSec: 0.5 });
  await addTakeTracked(shot.code, {
    date: '2026-10-04',
    shotCode: shot.code,
    shotId: shot.id as number,
    takenFrames: 6,
    wastedFrames: 0,
    remainingFrames: 0,
    percent: 0,
    updatedAt: Date.now(),
  });
  await addPropTracked(shot.code, {
    name: '茶杯',
    shotId: shot.id as number,
    fromFrame: 1,
    toFrame: 3,
    posX: 10,
    posY: 0,
    posZ: 0,
    rotation: 0,
    fixation: '黏土',
    updatedAt: Date.now(),
  });
  const reordered = [...frames.slice(1), frames[0]].map((f, i) => ({ ...f, frameNo: i + 1 }));
  await replaceFrameOrder(shot.code, shot.id as number, reordered);

  const text = await exportHandoffText();
  const pkg = decodePackage(text);
  assert.ok(pkg.operations.length >= 4);
  // 每设备顺序号覆盖 1..N 连续（包内按「阶段→顺序号」排列，不按 seq 原始顺序）
  const byDevice = new Map<string, number[]>();
  for (const op of pkg.operations) {
    const list = byDevice.get(op.deviceId) ?? [];
    list.push(op.seq);
    byDevice.set(op.deviceId, list);
  }
  for (const seqsOfDevice of byDevice.values()) {
    const sorted = [...new Set(seqsOfDevice)].sort((a, b) => a - b);
    assert.deepEqual(sorted, sorted.map((_, i) => i + 1));
  }

  // —— 模拟第二台机器：全新空库（镜头 / 帧都靠交接包建起来） ——
  // 注意：设备身份不变（同一进程模拟回网），只清数据
  await resetDataOnly();
  assert.equal((await api.listShots()).length, 0);

  const report = await importPackage(text);
  assert.equal(report.conflicts, 0);
  assert.equal(report.reshapedShots.includes('S01'), true);
  assert.equal(report.progressShots.includes('S01'), true);

  const shotsAfter = await api.listShots();
  assert.equal(shotsAfter.length, 1);
  const importedShot = shotsAfter[0];
  const afterFrames = (await api.listFrames(importedShot.id as number)).sort((a, b) => a.frameNo - b.frameNo);
  // 帧序以对方 uid 顺序重排，3 帧全部由包内快照建出
  assert.deepEqual(afterFrames.map((f) => f.uid), reordered.map((f) => f.uid));
  // 曝光并入（原首帧现在排在段尾）
  assert.equal(afterFrames[afterFrames.length - 1].exposureSec, 0.5);
  // 道具并入
  const props = await api.listProps(importedShot.id as number);
  assert.equal(props.some((p) => p.name === '茶杯' && p.posX === 10), true);
  // 实拍并入 + 剩余张数同步
  const takes = await api.listTakesByShot(importedShot.id as number);
  assert.equal(takes.length, 1);
  assert.equal(takes[0].takenFrames, 6);
  assert.equal(takes[0].remainingFrames, 0); // 3 帧计划 - 6 张 → 0
  assert.equal(takes[0].percent, 100);
  assert.equal(importedShot.progressPercent, 100);

  // 操作日志已落（含完整 op）
  const ops = await api.listOps();
  assert.ok(ops.length >= 4);
});

/** 接收端建底：只写数据、不产生本机交接操作（等价于该机器更早前就在用） */
async function seedShotUntracked(code = 'S01', frameCount = 6): Promise<Shot> {
  const now = Date.now();
  const shotId = await api.addShot({
    code,
    sceneName: '测试场景',
    fps: 24,
    durationSec: frameCount / 24,
    startFrame: 1,
    endFrame: frameCount,
    status: '拍摄中',
    owner: '',
    progressPercent: 0,
    createdAt: now,
    updatedAt: now,
  });
  for (let i = 0; i < frameCount; i += 1) {
    await api.addFrame(createEmptyFrame(shotId, i + 1));
  }
  return (await api.getShot(shotId)) as Shot;
}

test('重试导入同一包：幂等不重复，实拍不翻倍', async () => {
  await resetDb();
  setDeviceCapacity(50000);
  const { shot } = await seedShot('S01', 6);
  await addTakeTracked(shot.code, {
    date: '2026-10-04',
    shotCode: shot.code,
    shotId: shot.id as number,
    takenFrames: 2,
    wastedFrames: 0,
    remainingFrames: 0,
    percent: 0,
    updatedAt: Date.now(),
  });
  const text = await exportHandoffText();

  await resetDataOnly();
  await seedShotUntracked('S01', 6);
  const r1 = await importPackage(text);
  // 包里含建档 / 首帧序 / 实拍等多条操作
  assert.ok(r1.applied >= 1);
  const r2 = await importPackage(text);
  assert.equal(r2.applied, 0);
  assert.ok(r2.skipped >= 1);
  const takes = await api.listTakes();
  assert.equal(takes.length, 1);
  assert.equal(takes[0].takenFrames, 2);
});

test('同一帧两边都改：冲突并列、本机数据不变，采用对方后落本机操作', async () => {
  await resetDb();
  setDeviceCapacity(50000);
  const { shot, frames } = await seedShot('S01', 2);
  // 本机先改曝光（rev 1 → 2，产生 seq 1）
  await editFrameExposure(shot.code, frames[0], { exposureSec: 0.5, aperture: 4 });

  // 对方基于 rev 1 也改了同一帧
  const incoming: Record<string, unknown> = {
    format: 'gbstopmotion-handoff',
    version: 1,
    deviceId: 'device-B',
    deviceName: '实拍机B',
    createdAt: Date.now(),
    operations: [
      {
        op: 'frame.exposure',
        deviceId: 'device-B',
        seq: 1,
        at: Date.now(),
        shotCode: 'S01',
        frameUid: frames[0].uid,
        frameNo: 1,
        baseRev: 1,
        payload: {
          shotCount: 2,
          exposureSec: 1,
          aperture: 8,
          iso: 200,
          shutterAngle: 180,
          lighting: '主灯 + 柔光箱',
          propOffsetMm: 0,
          note: '',
        },
      },
    ],
  };
  (incoming as { checksum?: string }).checksum = checksumOf(incoming);

  const report = await importPackage(JSON.stringify(incoming));
  assert.equal(report.conflicts, 1);
  // 选定前本机值不动
  let local = await api.listFrames(shot.id as number);
  assert.equal(local[0].exposureSec, 0.5);
  assert.equal(local[0].aperture, 4);

  // 待整理里选「采用对方」
  const pending = await api.listPending();
  assert.equal(pending.length, 1);
  await resolveExposureConflict(pending[0], 'incoming');
  local = await api.listFrames(shot.id as number);
  assert.equal(local[0].exposureSec, 1);
  assert.equal(local[0].aperture, 8);
  assert.equal((await api.listPending()).length, 0);

  // 采用动作记为本机操作（回传不会再冲突）
  const ops = await api.listOps();
  assert.ok(ops.some((o) => o.op === 'frame.exposure'));
});

test('找不到落点：标待整理、可忽略 / 认领；忽略不删帧', async () => {
  await resetDb();
  setDeviceCapacity(50000);
  await seedShot('S01', 2);
  const other = await seedShot('S02', 2);

  const pack = {
    format: 'gbstopmotion-handoff',
    version: 1,
    deviceId: 'device-B',
    deviceName: 'B',
    createdAt: Date.now(),
    operations: [
      {
        op: 'frame.exposure',
        deviceId: 'device-B',
        seq: 1,
        at: Date.now(),
        shotCode: 'SXX',
        frameUid: 'ghost-frame',
        frameNo: 1,
        baseRev: 1,
        payload: {
          shotCount: 2, exposureSec: 1, aperture: 8, iso: 200, shutterAngle: 180,
          lighting: '', propOffsetMm: 0, note: '',
        },
      },
    ],
  } as unknown as Record<string, unknown>;
  pack.checksum = checksumOf(pack);

  const report = await importPackage(JSON.stringify(pack));
  assert.equal(report.unlanded, 1);
  const pending = await api.listPending();
  assert.equal(pending[0].reason, 'unknown-shot');
  await ignorePending(pending[0].id as number);
  assert.equal((await api.listPending()).length, 0);
  // 两镜头帧都还在
  assert.equal((await api.listAllFrames()).length, 4);
  void other;
});

test('大包超容量：拒绝导入并保留原记录；调大容量后可重试成功', async () => {
  await resetDb();
  setDeviceCapacity(500); // 容量故意调小
  await seedShotUntracked('S01', 1);

  const ops = Array.from({ length: 1001 }, (_, i) => ({
    op: 'take.add',
    deviceId: 'device-B',
    seq: i + 1,
    at: Date.now() + i,
    shotCode: 'S01',
    takeUid: `take-${i + 1}`,
    date: '2026-10-04',
    takenFrames: 1,
    wastedFrames: 0,
  }));
  const pack: Record<string, unknown> = {
    format: 'gbstopmotion-handoff',
    version: 1,
    deviceId: 'device-B',
    deviceName: 'B',
    createdAt: Date.now(),
    operations: ops,
  };
  pack.checksum = checksumOf(pack);

  const text = JSON.stringify(pack);
  await assert.rejects(
    () => importPackage(text),
    (e: unknown) => e instanceof HandoffError && e.code === 'E_CAPACITY',
  );
  // 原记录保留：实拍 0 条、操作日志无任何对方项
  assert.equal((await api.listTakes()).length, 0);
  const logged = await api.listOpLog();
  assert.equal(logged.some((r) => r.deviceId === 'device-B'), false);

  // 放开容量后重试成功
  setDeviceCapacity(100000);
  const report = await importPackage(text);
  assert.equal(report.applied, 1001);
  assert.equal((await api.listTakes()).length, 1001);
});

test('顺序号缺项：整包拒绝，原记录保留，可在拿全包后重试', async () => {
  await resetDb();
  setDeviceCapacity(50000);
  await seedShot('S01', 2);
  const ops = [1, 3].map((seq) => ({
    op: 'take.add' as const,
    deviceId: 'device-B',
    seq,
    at: Date.now(),
    shotCode: 'S01',
    takeUid: `take-${seq}`,
    date: '2026-10-04',
    takenFrames: 1,
    wastedFrames: 0,
  }));
  const pack: Record<string, unknown> = {
    format: 'gbstopmotion-handoff',
    version: 1,
    deviceId: 'device-B',
    deviceName: 'B',
    createdAt: Date.now(),
    operations: ops,
  };
  pack.checksum = checksumOf(pack);
  await assert.rejects(
    () => importPackage(JSON.stringify(pack)),
    (e: unknown) => e instanceof HandoffError && e.code === 'E_GAP',
  );
  assert.equal((await api.listTakes()).length, 0);
});

test('v4 升级：旧 frames/props/takes 补齐交接字段，旧页面字段照常', async () => {
  // 用一个「只知道 v3 schema」的临时 Dexie 连接模拟旧版本 App，写入旧数据
  await db.close();
  await db.delete();
  const legacy = new Dexie('gbstopmotion-db');
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
  await legacy.table('shots').add({
    code: 'OLD', sceneName: '旧', fps: 24, durationSec: 1, startFrame: 1, endFrame: 24,
    status: '未开机', owner: '', progressPercent: 0, createdAt: 1, updatedAt: 1,
  });
  await legacy.table('frames').add({
    frameNo: 1, shotId: 1, shotCount: 2, exposureSec: 0.25, aperture: 5.6, iso: 200,
    shutterAngle: 180, lighting: '主灯', propOffsetMm: 3, note: '旧帧', updatedAt: 1,
  });
  await legacy.table('props').add({
    name: '旧道具', shotId: 1, fromFrame: 1, toFrame: 24, posX: 0, posY: 0, posZ: 0,
    rotation: 0, fixation: '支架', updatedAt: 1,
  });
  await legacy.table('takes').add({
    date: '2026-09-01', shotCode: 'OLD', shotId: 1, takenFrames: 4, wastedFrames: 0,
    remainingFrames: 20, percent: 17, updatedAt: 1,
  });
  legacy.close();

  // 打开新代码库 → 触发 v4 upgrade
  await db.open();
  const shots = await api.listShots();
  assert.equal(shots[0].code, 'OLD');
  const frames = await api.listAllFrames();
  assert.equal(typeof frames[0].uid, 'string');
  assert.equal(frames[0].rev, 1);
  assert.equal(frames[0].trajectory, 'ok');
  // 旧页面字段不变
  assert.equal(frames[0].propOffsetMm, 3);
  assert.equal(frames[0].note, '旧帧');
  const props = await api.listAllProps();
  assert.equal(typeof props[0].uid, 'string');
  assert.equal(props[0].name, '旧道具');
  const takes = await api.listTakes();
  assert.equal(typeof takes[0].uid, 'string');
  assert.equal(takes[0].takenFrames, 4);
});

/** 与 package.ts 同一 FNV-1a 算法构造测试包校验和 */
function checksumOf(obj: Record<string, unknown>): string {
  const { checksum: _omit, ...head } = obj;
  const text = JSON.stringify(head);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
