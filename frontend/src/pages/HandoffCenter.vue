<script setup lang="ts">
/**
 * 拍摄交接中心：
 *  - 上半区：本机设备标识 / 容量，生成可复制的交接包（带首尾标记）。
 *  - 中间区：粘贴对方交接包，预览 → 导入；容量不足 / 缺项 / 校验失败会拒绝并保留原记录。
 *  - 下半区：待整理清单。冲突在选定前不改本机数据，可「采用本机 / 采用对方 / 忽略」；
 *    找不到落点的帧可指定镜头认领。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import {
  getDeviceCapacity,
  getDeviceId,
  getDeviceName,
  getDeviceSeq,
  setDeviceCapacity,
  setDeviceName,
} from '../handoff/device';
import { exportHandoffText } from '../handoff/exportService';
import { importPackage, previewPackage } from '../handoff/importService';
import {
  claimOrphanFrame,
  ignorePending,
  resolveExposureConflict,
  resolvePropConflict,
} from '../handoff/resolve';
import { HandoffError, type ImportReport } from '../handoff/types';
import type { PendingItem } from '../handoff/dbTypes';
import EmptyState from '../components/common/EmptyState.vue';

const deviceId = ref(getDeviceId());
const deviceName = ref(getDeviceName());
const capacity = ref(getDeviceCapacity());
const seqUsed = ref(getDeviceSeq());
const recordCount = ref(0);
const pendingCount = ref(0);

const exportText = ref('');
const forwardAll = ref(false);
const pasteText = ref('');
const feedback = ref<{ type: 'ok' | 'err'; text: string } | null>(null);
const previewInfo = ref<{ deviceName: string; count: number; createdAt: number } | null>(null);
const report = ref<ImportReport | null>(null);
const busy = ref(false);

const pending = ref<PendingItem[]>([]);
const claimShotId = ref<Record<string, number>>({});

const shots = ref<{ id: number; code: string; sceneName: string }[]>([]);

const router = useRouter();
const shotStore = useShotStore();
const frameStore = useFrameStore();
const conflictItems = computed(() => pending.value.filter((p) => p.reason.endsWith('-conflict')));
const unlandedItems = computed(() => pending.value.filter((p) => !p.reason.endsWith('-conflict')));

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  await refresh();
});

async function refresh() {
  seqUsed.value = getDeviceSeq();
  recordCount.value = await api.totalRecordCount();
  pendingCount.value = await api.countPending();
  pending.value = await api.listPending();
  await shotStore.load();
  shots.value = shotStore.shots
    .filter((s) => typeof s.id === 'number')
    .map((s) => ({ id: s.id as number, code: s.code, sceneName: s.sceneName }));
  window.dispatchEvent(new Event('gbstopmotion:pending-changed'));
}

function flash(type: 'ok' | 'err', text: string) {
  feedback.value = { type, text };
}

async function saveDeviceName() {
  deviceName.value = setDeviceName(deviceName.value);
  flash('ok', '设备名已保存（设备标识不可改）');
}

async function saveCapacity() {
  capacity.value = setDeviceCapacity(capacity.value);
  await refresh();
  flash('ok', `本机容量已设为 ${capacity.value} 行`);
}

async function generatePackage() {
  exportText.value = await exportHandoffText({ allDevices: forwardAll.value });
  const lineCount = exportText.value.split('\n').length;
  flash('ok', `已生成交接包（${lineCount} 行），全选复制后发给对班即可`);
}

async function copyPackage() {
  if (!exportText.value) {
    await generatePackage();
  }
  try {
    await navigator.clipboard.writeText(exportText.value);
    flash('ok', '交接包已复制到剪贴板');
  } catch {
    flash('err', '浏览器禁止了剪贴板访问，请手动全选文本框复制');
  }
}

async function doPreview() {
  report.value = null;
  try {
    const pkg = previewPackage(pasteText.value);
    previewInfo.value = { deviceName: pkg.deviceName, count: pkg.operations.length, createdAt: pkg.createdAt };
    flash('ok', `校验通过：来自 ${pkg.deviceName}，共 ${pkg.operations.length} 项改动`);
  } catch (e) {
    previewInfo.value = null;
    if (e instanceof HandoffError) flash('err', e.message);
    else flash('err', (e as Error).message);
  }
}

async function doImport() {
  busy.value = true;
  report.value = null;
  try {
    report.value = await importPackage(pasteText.value);
    const r = report.value;
    const parts = [`并入 ${r.applied} 项`];
    if (r.skipped) parts.push(`跳过已应用 ${r.skipped} 项`);
    if (r.conflicts) parts.push(`冲突并列保留 ${r.conflicts} 项`);
    if (r.unlanded) parts.push(`待整理 ${r.unlanded} 项`);
    if (r.reshapedShots.length) parts.push(`镜头 ${r.reshapedShots.join('、')} 帧序已重算`);
    if (r.progressShots.length) parts.push(`剩余张数已同步`);
    flash(r.conflicts || r.unlanded ? 'err' : 'ok', `导入完成：${parts.join('，')}`);
    pasteText.value = '';
    previewInfo.value = null;
    // 让总览 / 编排台 / 详情页看到合并后的镜头、帧序与进度
    await shotStore.load();
    if (frameStore.shotId !== null) await frameStore.loadForShot(frameStore.shotId);
    await refresh();
  } catch (e) {
    if (e instanceof HandoffError) {
      const prefix =
        e.code === 'E_CAPACITY'
          ? '容量不足，已拒绝导入（原记录保留）'
          : e.code === 'E_GAP'
            ? '顺序号缺项，已拒绝导入（原记录保留）'
            : '导入失败，原记录已恢复，可修正后重试';
      flash('err', `${prefix}：${e.message}`);
    } else {
      flash('err', `导入失败，原记录已恢复，可重试：${(e as Error).message}`);
    }
  } finally {
    busy.value = false;
  }
}

async function choose(item: PendingItem, choice: 'local' | 'incoming' | 'ignore') {
  try {
    if (item.reason === 'exposure-conflict') await resolveExposureConflict(item, choice);
    else if (item.reason === 'prop-conflict') await resolvePropConflict(item, choice);
    else await ignorePending(item.id as number);
    await refresh();
    flash('ok', choice === 'incoming' ? '已采用对方值并记为本机改动' : choice === 'local' ? '已保留本机值' : '已忽略该待整理项');
  } catch (e) {
    flash('err', (e as Error).message);
  }
}

async function claimFrame(item: PendingItem) {
  const targetId = claimShotId.value[item.refUid];
  if (typeof targetId !== 'number') {
    flash('err', '请先选择认领镜头');
    return;
  }
  await claimOrphanFrame(item, targetId);
  await refresh();
  flash('ok', '已把该帧追加到目标镜头帧序段尾');
}

function openShot(id: number) {
  void router.push(`/shots/${id}`);
}

function diffText(value: unknown): string {
  if (value === undefined || value === null) return '—';
  return JSON.stringify(value, null, 0);
}

const reasonLabel: Record<string, string> = {
  'exposure-conflict': '曝光冲突',
  'prop-conflict': '道具区间冲突',
  'frame-orphan': '帧无落点',
  'prop-offrange': '道具区间越界',
  'unknown-shot': '镜头不存在',
  'unknown-frame': '帧找不到落点',
  'unknown-prop': '道具找不到落点',
};
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>拍摄交接中心</h1>
        <p class="sub">两台机器轮流离线记录同一镜头：改动带设备标识与顺序号，回网后粘贴交接包合并</p>
      </div>
      <div class="head-badge">
        <span class="dot" />
        本机顺序号已用 {{ seqUsed }}
      </div>
    </header>

    <p v-if="feedback" class="feedback" :class="feedback.type">{{ feedback.text }}</p>

    <div class="two-panel">
      <!-- 本机 / 导出 -->
      <div class="panel">
        <div class="panel-head"><h2>① 生成交接包</h2></div>
        <div class="form-grid">
          <label class="field">
            <span>设备标识（不可改）</span>
            <input :value="deviceId" readonly data-testid="handoff-device-id" />
          </label>
          <label class="field">
            <span>设备名</span>
            <input v-model="deviceName" maxlength="20" data-testid="handoff-device-name" />
          </label>
          <label class="field">
            <span>本机容量（行）</span>
            <input v-model.number="capacity" type="number" min="100" step="100" data-testid="handoff-capacity" />
          </label>
        </div>
        <div class="muted small">
          当前 {{ recordCount }} 行 · 待整理 {{ pendingCount }} 项 · 容量 {{ capacity }} 行；
          交接包超过 1000 项且预估超容量时会拒绝导入
        </div>
        <div class="actions">
          <button type="button" class="btn primary" data-testid="handoff-generate" @click="generatePackage">生成交接包</button>
          <button type="button" class="btn" @click="copyPackage">复制全文</button>
          <button type="button" class="btn tiny" @click="saveDeviceName">保存设备名</button>
          <button type="button" class="btn tiny" @click="saveCapacity">保存容量</button>
          <label class="inline-check">
            <input v-model="forwardAll" type="checkbox" />
            整包转发（含他机已并入操作）
          </label>
        </div>
        <textarea
          v-if="exportText"
          :value="exportText"
          readonly
          rows="8"
          class="pack"
          data-testid="handoff-export"
          @focus="($event.target as HTMLTextAreaElement).select()"
        />
      </div>

      <!-- 导入 -->
      <div class="panel">
        <div class="panel-head"><h2>② 粘贴对方交接包</h2></div>
        <textarea
          v-model="pasteText"
          rows="8"
          class="pack"
          placeholder="粘贴含 -----BEGIN GBSTOPMOTION HANDOFF----- 标记的整段文本"
          data-testid="handoff-import"
        ></textarea>
        <div class="actions">
          <button type="button" class="btn" data-testid="handoff-preview" @click="doPreview">校验预览</button>
          <button
            type="button"
            class="btn primary"
            :disabled="busy || !pasteText.trim()"
            data-testid="handoff-do-import"
            @click="doImport"
          >
            {{ busy ? '导入中…' : '导入并合并' }}
          </button>
        </div>
        <p v-if="previewInfo" class="muted small">
          来自 {{ previewInfo.deviceName }} · {{ previewInfo.count }} 项 ·
          {{ new Date(previewInfo.createdAt).toLocaleString('zh-CN') }}
        </p>
        <ul v-if="report" class="report" data-testid="handoff-report">
          <li>并入 {{ report.applied }} / {{ report.total }} 项</li>
          <li>跳过已应用 {{ report.skipped }} 项</li>
          <li>冲突并列 {{ report.conflicts }} 项 · 待整理 {{ report.unlanded }} 项</li>
          <li v-if="report.reshapedShots.length">帧序重算：{{ report.reshapedShots.join('、') }}</li>
          <li v-if="report.progressShots.length">剩余张数同步：{{ report.progressShots.join('、') }}</li>
        </ul>
      </div>
    </div>

    <!-- 待整理 -->
    <div class="panel">
      <div class="panel-head">
        <h2>③ 待整理（{{ pending.length }}）</h2>
        <span class="muted">冲突项选定前不改本机数据；不同帧 / 不同道具已直接并入，不会出现在这里</span>
      </div>

      <EmptyState v-if="!pending.length" title="没有待整理项" description="最近一次导入的改动已全部自动并入。" />

      <template v-else>
        <section v-if="conflictItems.length" class="pending-group">
          <h3>两边都改过，并列保留（{{ conflictItems.length }}）</h3>
          <table class="table" data-testid="pending-conflict-table">
            <thead>
              <tr><th>类型</th><th>镜号</th><th>说明</th><th>本机值</th><th>对方值</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in conflictItems" :key="item.id">
                <td><span class="tag warn">{{ reasonLabel[item.reason] ?? item.reason }}</span></td>
                <td class="mono">
                  {{ item.shotCode }}
                  <button
                    v-if="shots.some((s) => s.code === item.shotCode)"
                    type="button"
                    class="btn tiny link"
                    @click="openShot(shots.find((s) => s.code === item.shotCode)!.id)"
                  >
                    查看
                  </button>
                </td>
                <td>{{ item.note }}</td>
                <td class="val">{{ diffText(item.local) }}</td>
                <td class="val">{{ diffText(item.incoming) }}</td>
                <td class="row-actions">
                  <button type="button" class="btn tiny" data-testid="choose-local" @click="choose(item, 'local')">采用本机</button>
                  <button type="button" class="btn tiny primary" data-testid="choose-incoming" @click="choose(item, 'incoming')">采用对方</button>
                  <button type="button" class="btn tiny" @click="choose(item, 'ignore')">忽略</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="unlandedItems.length" class="pending-group">
          <h3>找不到落点（{{ unlandedItems.length }}）</h3>
          <table class="table" data-testid="pending-unlanded-table">
            <thead>
              <tr><th>类型</th><th>镜号</th><th>说明</th><th>认领</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in unlandedItems" :key="item.id">
                <td><span class="tag">{{ reasonLabel[item.reason] ?? item.reason }}</span></td>
                <td class="mono">
                  {{ item.shotCode }}
                  <button
                    v-if="shots.some((s) => s.code === item.shotCode)"
                    type="button"
                    class="btn tiny link"
                    @click="openShot(shots.find((s) => s.code === item.shotCode)!.id)"
                  >
                    查看
                  </button>
                </td>
                <td>{{ item.note }}</td>
                <td>
                  <select
                    v-if="item.reason === 'frame-orphan' || item.reason === 'unknown-frame'"
                    v-model.number="claimShotId[item.refUid]"
                  >
                    <option :value="undefined" disabled>选择镜头</option>
                    <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}</option>
                  </select>
                  <span v-else class="muted">—</span>
                </td>
                <td class="row-actions">
                  <button
                    v-if="item.reason === 'frame-orphan' || item.reason === 'unknown-frame'"
                    type="button"
                    class="btn tiny primary"
                    @click="claimFrame(item)"
                  >
                    追加到段尾
                  </button>
                  <button type="button" class="btn tiny" @click="choose(item, 'ignore')">保留并忽略</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
h3 {
  margin: 14px 0 8px;
  font-size: 14px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.head-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  color: #5a6472;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #36b37e;
}
.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) {
  .two-panel {
    grid-template-columns: 1fr;
  }
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 10px;
  flex-wrap: wrap;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.field input[readonly] {
  background: #f5f7fa;
  color: #6b7686;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.inline-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.pack {
  width: 100%;
  box-sizing: border-box;
  margin-top: 12px;
  border: 1px solid #cfd6e0;
  border-radius: 8px;
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  resize: vertical;
  background: #fbfcfe;
  color: #24344a;
}
.feedback {
  margin: 0;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.feedback.ok {
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
}
.feedback.err {
  background: #fef1f1;
  border: 1px solid #f4cccc;
  color: #b03a3a;
}
.report {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4a5464;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: top;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.val {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  max-width: 240px;
  word-break: break-all;
  color: #4a5464;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.muted.small {
  margin-top: 8px;
}
.row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  background: #eef1f6;
  color: #5a6472;
  font-size: 11px;
  white-space: nowrap;
}
.tag.warn {
  background: #fdf3e2;
  color: #9a6a16;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.link {
  border-color: transparent;
  background: none;
  color: #2f6fed;
  padding: 0 4px;
  height: 20px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
select {
  height: 26px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  font-size: 12px;
  background: #fff;
}
</style>
