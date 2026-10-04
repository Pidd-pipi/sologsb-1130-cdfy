import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHandoff, detectGap, projectRowCounts } from '../handoff/merge';
import { buildPackage, encodePackage, decodePackage, fnv1a } from '../handoff/package';
import { HandoffError } from '../handoff/types';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { FrameExposureOp, FrameOrderOp, HandOp, PropUpsertOp, TakeAddOp } from '../handoff/types';

let counter = 0;
const nid = () => ++counter;

function makeShot(over: Partial<Shot> = {}): Shot {
  return {
    id: nid(),
    code: 'S01',
    sceneName: '场',
    fps: 24,
    durationSec: 2,
    startFrame: 1,
    endFrame: 48,
    status: '未开机',
    owner: '',
    progressPercent: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeFrame(over: Partial<FrameEntry> = {}): FrameEntry {
  return {
    id: nid(),
    frameNo: 1,
    shotId: 1,
    shotCount: 2,
    exposureSec: 0.25,
    aperture: 5.6,
    iso: 200,
    shutterAngle: 180,
    lighting: '主灯',
    propOffsetMm: 0,
    note: '',
    uid: `f${nid()}`,
    rev: 1,
    lastChange: { deviceId: 'A', seq: 1 },
    trajectory: 'ok',
    updatedAt: 0,
    ...over,
  };
}

function makeProp(over: Partial<PropState> = {}): PropState {
  return {
    id: nid(),
    name: '茶杯',
    shotId: 1,
    fromFrame: 1,
    toFrame: 24,
    posX: 0,
    posY: 0,
    posZ: 0,
    rotation: 0,
    fixation: '支架',
    uid: `p${nid()}`,
    rev: 1,
    lastChange: { deviceId: 'A', seq: 1 },
    trajectory: 'ok',
    updatedAt: 0,
    ...over,
  };
}

function makeTake(over: Partial<TakeLog> = {}): TakeLog {
  return {
    id: nid(),
    date: '2026-10-01',
    shotCode: 'S01',
    shotId: 1,
    takenFrames: 0,
    wastedFrames: 0,
    remainingFrames: 48,
    percent: 0,
    uid: `t${nid()}`,
    rev: 1,
    lastChange: { deviceId: 'A', seq: 1 },
    updatedAt: 0,
    ...over,
  };
}

const exposureOp = (d: Partial<FrameExposureOp> & { frameUid: string }): FrameExposureOp => ({
  op: 'frame.exposure',
  deviceId: 'B',
  seq: 1,
  at: 100,
  shotCode: 'S01',
  frameNo: 1,
  baseRev: 1,
  payload: {
    shotCount: 2,
    exposureSec: 0.5,
    aperture: 4,
    iso: 400,
    shutterAngle: 180,
    lighting: '主灯',
    propOffsetMm: 0,
    note: '',
  },
  ...d,
});

test('不同帧的曝光改动直接并入，不产生待整理', () => {
  const shot = makeShot();
  const f1 = makeFrame({ id: 10, shotId: shot.id, frameNo: 1, uid: 'f1' });
  const f2 = makeFrame({ id: 11, shotId: shot.id, frameNo: 2, uid: 'f2' });
  const input = { shots: [shot], frames: [f1, f2], props: [], takes: [], appliedKeys: new Set<string>() };
  const op = exposureOp({ frameUid: 'f2', baseRev: 1 });
  const out = mergeHandoff(input, [op]);
  assert.equal(out.pending.length, 0);
  assert.equal(out.report.applied, 1);
  assert.equal(out.frames.find((f) => f.uid === 'f2')?.exposureSec, 0.5);
  // 本机未涉及的帧保持原值
  assert.equal(out.frames.find((f) => f.uid === 'f1')?.exposureSec, 0.25);
});

test('同一帧曝光：快进（baseRev 等于本机 rev）直接采用', () => {
  const shot = makeShot();
  const f1 = makeFrame({ shotId: shot.id, uid: 'f1', rev: 3 });
  const input = { shots: [shot], frames: [f1], props: [], takes: [], appliedKeys: new Set<string>() };
  const op = exposureOp({ frameUid: 'f1', baseRev: 3, seq: 5 });
  const out = mergeHandoff(input, [op]);
  assert.equal(out.pending.length, 0);
  assert.equal(out.frames[0].exposureSec, 0.5);
  assert.equal(out.frames[0].rev, 4);
  assert.deepEqual(out.frames[0].lastChange, { deviceId: 'B', seq: 5 });
});

test('同一帧曝光两边都改：并列保留待整理，本机数据不变', () => {
  const shot = makeShot();
  const f1 = makeFrame({ shotId: shot.id, uid: 'f1', rev: 4, exposureSec: 0.125, lastChange: { deviceId: 'A', seq: 9 } });
  const input = { shots: [shot], frames: [f1], props: [], takes: [], appliedKeys: new Set<string>() };
  // 对方基于 rev 1（= 本机更早版本），且本机后来在 A 上改过 → 分叉
  const op = exposureOp({ frameUid: 'f1', baseRev: 1, seq: 2 });
  const out = mergeHandoff(input, [op]);
  assert.equal(out.pending.length, 1);
  assert.equal(out.pending[0].reason, 'exposure-conflict');
  assert.equal(out.report.conflicts, 1);
  // 选定前本机数据不改
  assert.equal(out.frames[0].exposureSec, 0.125);
  assert.equal(out.frames[0].rev, 4);
});

test('同设备后续编辑覆盖自己的旧值不算冲突', () => {
  const shot = makeShot();
  const f1 = makeFrame({ shotId: shot.id, uid: 'f1', rev: 5, lastChange: { deviceId: 'B', seq: 4 } });
  const input = { shots: [shot], frames: [f1], props: [], takes: [], appliedKeys: new Set<string>() };
  const op = exposureOp({ frameUid: 'f1', baseRev: 1, seq: 5 });
  const out = mergeHandoff(input, [op]);
  assert.equal(out.pending.length, 0);
  assert.equal(out.frames[0].exposureSec, 0.5);
});

test('不同道具直接并入；同一道具同一区间两边都改才冲突', () => {
  const shot = makeShot();
  const cup = makeProp({ shotId: shot.id, uid: 'p1', name: '茶杯', rev: 2, lastChange: { deviceId: 'A', seq: 3 } });
  const input = { shots: [shot], frames: [], props: [cup], takes: [], appliedKeys: new Set<string>() };

  // 不同 uid → 并入为新行
  const newProp: PropUpsertOp = {
    op: 'prop.upsert', deviceId: 'B', seq: 1, at: 50, shotCode: 'S01', propUid: 'p2', baseRev: 0,
    payload: { name: '书', fromFrame: 1, toFrame: 10, posX: 5, posY: 0, posZ: 0, rotation: 0, fixation: '黏土' },
  };
  // 同 uid、区间不变、本机已分叉 → 冲突
  const conflictProp: PropUpsertOp = {
    op: 'prop.upsert', deviceId: 'B', seq: 2, at: 51, shotCode: 'S01', propUid: 'p1', baseRev: 1,
    payload: { name: '茶杯', fromFrame: 1, toFrame: 24, posX: 9, posY: 0, posZ: 0, rotation: 0, fixation: '支架' },
  };
  const out = mergeHandoff(input, [newProp, conflictProp]);
  assert.equal(out.props.length, 2);
  assert.equal(out.pending.filter((p) => p.reason === 'prop-conflict').length, 1);
  // 本机茶杯值不动
  assert.equal(out.props.find((p) => p.uid === 'p1')?.posX, 0);
});

test('帧序变化：按 uid 重排，本机多出的帧追加段尾并待整理，道具轨迹失效', () => {
  const shot = makeShot({ id: 1, startFrame: 1, endFrame: 3, durationSec: 3 / 24 });
  const a = makeFrame({ id: 1, shotId: 1, frameNo: 1, uid: 'a' });
  const b = makeFrame({ id: 2, shotId: 1, frameNo: 2, uid: 'b' });
  const c = makeFrame({ id: 3, shotId: 1, frameNo: 3, uid: 'c' });
  // 对方新插入的帧 d
  const d = makeFrame({ uid: 'd', rev: 1, lastChange: { deviceId: 'B', seq: 1 } });
  const prop = makeProp({ shotId: 1, uid: 'pr1', fromFrame: 1, toFrame: 4 });
  const offProp = makeProp({ id: 99, shotId: 1, uid: 'pr2', name: '远', fromFrame: 8, toFrame: 9 });

  const orderOp: FrameOrderOp = {
    op: 'frame.order',
    deviceId: 'B',
    seq: 1,
    at: 100,
    shotCode: 'S01',
    order: ['d', 'a', 'b'],
    frames: [
      {
        uid: 'd',
        frame: {
          shotCount: d.shotCount,
          exposureSec: d.exposureSec,
          aperture: d.aperture,
          iso: d.iso,
          shutterAngle: d.shutterAngle,
          lighting: d.lighting,
          propOffsetMm: d.propOffsetMm,
          note: d.note,
        },
        rev: 1,
        lastChange: { deviceId: 'B', seq: 1 },
      },
    ],
  };

  const input = {
    shots: [shot],
    frames: [a, b, c],
    props: [prop, offProp],
    takes: [],
    appliedKeys: new Set<string>(),
  };
  const out = mergeHandoff(input, [orderOp]);

  const shotFrames = out.frames.filter((f) => f.shotId === 1).sort((x, y) => x.frameNo - y.frameNo);
  assert.deepEqual(shotFrames.map((f) => f.uid), ['d', 'a', 'b', 'c']);
  assert.deepEqual(shotFrames.map((f) => f.frameNo), [1, 2, 3, 4]);
  // 本机多出的 c 不删除，标 frame-orphan
  const orphan = out.pending.find((p) => p.reason === 'frame-orphan');
  assert.ok(orphan, '多出的帧应标待整理');
  assert.equal(orphan?.refUid, 'c');
  // 镜头区间 / 时长重算
  assert.equal(out.shots[0].endFrame, 4);
  assert.ok(Math.abs(out.shots[0].durationSec - 4 / 24) < 1e-3);
  // 轨迹失效重算：在界内的 prop 标 stale；越界的 toFrame 夹回
  assert.equal(out.props.find((p) => p.uid === 'pr1')?.trajectory, 'stale');
  assert.equal(out.props.find((p) => p.uid === 'pr1')?.toFrame, 4);
  // 整体越界 → prop-offrange
  assert.ok(out.pending.some((p) => p.reason === 'prop-offrange' && p.refUid === 'pr2'));
  assert.ok(out.report.reshapedShots.includes('S01'));
});

test('实拍按条并入、幂等去重，剩余张数 / 完成百分比同步', () => {
  const shot = makeShot({ id: 1, fps: 24, durationSec: 2 }); // 48 帧
  const take1: TakeAddOp = {
    op: 'take.add', deviceId: 'B', seq: 1, at: 10, shotCode: 'S01',
    takeUid: 't1', date: '2026-10-02', takenFrames: 12, wastedFrames: 1,
  };
  const take2: TakeAddOp = {
    op: 'take.add', deviceId: 'B', seq: 2, at: 11, shotCode: 'S01',
    takeUid: 't2', date: '2026-10-03', takenFrames: 12, wastedFrames: 0,
  };
  const input = { shots: [shot], frames: [], props: [], takes: [], appliedKeys: new Set<string>() };
  const out1 = mergeHandoff(input, [take1, take2]);
  assert.equal(out1.takes.length, 2);
  assert.equal(out1.takes[0].remainingFrames, 24);
  assert.equal(out1.takes[0].percent, 50);
  assert.equal(out1.shots[0].progressPercent, 50);
  assert.ok(out1.report.progressShots.includes('S01'));

  // 重试：同样的操作幂等跳过，张数不翻倍
  const applied = new Set(out1.appliedOps.map((op) => `${op.deviceId} ${op.seq}`));
  const input2 = { shots: out1.shots, frames: [], props: [], takes: out1.takes, appliedKeys: applied };
  const out2 = mergeHandoff(input2, [take1, take2]);
  assert.equal(out2.report.applied, 0);
  assert.equal(out2.report.skipped, 2);
  assert.equal(out2.takes.length, 2);
});

test('找不到镜头 / 帧的条目标待整理而不是丢弃', () => {
  const shot = makeShot({ code: 'S09' });
  const f1 = makeFrame({ shotId: 9, uid: 'fx' });
  const input = { shots: [shot], frames: [f1], props: [], takes: [], appliedKeys: new Set<string>() };
  const op = exposureOp({ frameUid: 'missing', shotCode: 'S09' });
  const out = mergeHandoff(input, [op]);
  assert.equal(out.pending[0].reason, 'unknown-frame');
  assert.equal(out.report.unlanded, 1);

  const op2 = exposureOp({ frameUid: 'fx', shotCode: 'SXX' });
  const out2 = mergeHandoff(input, [op2]);
  assert.equal(out2.pending[0].reason, 'unknown-shot');
});

test('detectGap：包内顺序号必须连续，且相对水位不跳号', () => {
  const ops = [
    exposureOp({ frameUid: 'f1', seq: 1 }),
    exposureOp({ frameUid: 'f2', seq: 3 }),
  ];
  assert.ok(detectGap(ops, new Set<string>())?.includes('缺项'));

  // 本机已应用 B:1..3，包却从 B:6 开始 → 缺口
  const watermark = new Set(['B 1', 'B 2', 'B 3']);
  const jump = [exposureOp({ frameUid: 'f1', seq: 6 })];
  assert.ok(detectGap(jump, watermark)?.includes('缺口'));

  // 从 B:4 连续开始 → 无缺口
  const ok = [exposureOp({ frameUid: 'f1', seq: 4 }), exposureOp({ frameUid: 'f2', seq: 5 })];
  assert.equal(detectGap(ok, watermark), null);
});

test('projectRowCounts 预估新增行数', () => {
  const shot = makeShot();
  const f = makeFrame({ shotId: 1, uid: 'f1' });
  const takeOp: TakeAddOp = {
    op: 'take.add', deviceId: 'B', seq: 1, at: 1, shotCode: 'S01',
    takeUid: 'new-t', date: '2026-10-04', takenFrames: 3, wastedFrames: 0,
  };
  const input = { shots: [shot], frames: [f], props: [], takes: [], appliedKeys: new Set<string>() };
  const total = projectRowCounts(input, [takeOp], 2);
  assert.equal(total, 1 + 1 + 0 + 1 + 2);
});

test('交接包编解码 + 校验和：篡改 / 截断被拒绝', () => {
  const ops: HandOp[] = [exposureOp({ frameUid: 'f1', seq: 1 })];
  const pkg = buildPackage('B', '排帧机B', ops);
  const text = encodePackage(pkg);
  assert.ok(text.includes('BEGIN GBSTOPMOTION HANDOFF'));
  // 允许前后有聊天文字
  const decoded = decodePackage(`发给你：\n${text}\n辛苦并入`);
  assert.equal(decoded.deviceName, '排帧机B');

  // 损坏
  const corrupted = text.replace('"iso":400', '"iso":800');
  assert.throws(() => decodePackage(corrupted), (e: unknown) => e instanceof HandoffError && (e as HandoffError).code === 'E_CHECKSUM');
  // 空 / 非 JSON
  assert.throws(() => decodePackage(''), (e: unknown) => (e as HandoffError).code === 'E_PARSE');
  assert.throws(() => decodePackage('hello world'), (e: unknown) => (e as HandoffError).code === 'E_PARSE');
});

test('fnv1a 稳定', () => {
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(typeof fnv1a('abc'), 'string');
});

test('输入不被合并过程修改（容量 / 校验失败时原记录仍在内存）', () => {
  const shot = makeShot();
  const f1 = makeFrame({ shotId: shot.id, uid: 'f1', exposureSec: 0.25 });
  const input = { shots: [shot], frames: [f1], props: [], takes: [], appliedKeys: new Set<string>() };
  const op = exposureOp({ frameUid: 'f1', baseRev: 1 });
  mergeHandoff(input, [op]);
  assert.equal(f1.exposureSec, 0.25);
  assert.equal(f1.rev, 1);
});
