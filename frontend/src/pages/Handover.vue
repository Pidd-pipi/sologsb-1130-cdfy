<script setup lang="ts">
/**
 * 拍摄交接：两台机器离线轮流记录后，用可粘贴 JSON 包合并。
 * - 导出：本机全量快照（帧/道具/实拍各带设备标识与顺序号）
 * - 导入：不同帧或不同道具直接并入；同一帧曝光、同一道具区间两边都改过时并列保留；
 *   帧序变化导致道具轨迹失效或实拍剩余变化会自动重算；找不到落点的条目进待整理；
 *   超 1000 项且本机容量不足时整单拒绝，失败自动回滚，可重试。
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useSyncStore } from '../stores/syncStore';
import { useShotStore } from '../stores/shotStore';
import { buildHandoverPackage, ensureCapacity, mergeHandover, packageItemCount, parseHandoverText } from '../sync/engine';
import {
  attachOrphanToShot,
  discardPending,
  fixStalePropRange,
  resolveWithLocal,
  resolveWithRemote,
} from '../sync/resolve';
import { formatDateTime } from '../utils/format';
import EmptyState from '../components/common/EmptyState.vue';
import type { PendingEntry } from '../types/sync';

const syncStore = useSyncStore();
const shotStore = useShotStore();
const { deviceId, deviceName, pending } = storeToRefs(syncStore);

const editingName = ref('');
const exportText = ref('');
const exportMeta = ref<{ count: number; at: number } | null>(null);
const importText = ref('');
const importing = ref(false);
const parsing = ref(false);
const preflight = ref<{ count: number; freeMb?: number; needMb?: number } | null>(null);
const errorText = ref('');
const notice = ref<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(null);
const busyId = ref<number | null>(null);
const attachTarget = ref<Record<number, number>>({});
const rangeFix = ref<Record<number, { from: number; to: number }>>({});

onMounted(async () => {
  syncStore.initDevice();
  editingName.value = deviceName.value;
  await syncStore.loadPending();
  if (!shotStore.ready) await shotStore.load();
});

function flash(type: 'ok' | 'warn' | 'err', text: string) {
  notice.value = { type, text };
  window.setTimeout(() => {
    if (notice.value?.text === text) notice.value = null;
  }, 6000);
}

function saveName() {
  if (!editingName.value.trim()) {
    flash('err', '设备名不能为空');
    return;
  }
  syncStore.renameDevice(editingName.value.trim());
  flash('ok', `本机标识名称已更新为「${deviceName.value}」`);
}

async function doExport() {
  errorText.value = '';
  try {
    const { text, itemCount } = await buildHandoverPackage();
    exportText.value = text;
    exportMeta.value = { count: itemCount, at: Date.now() };
    flash('ok', `已生成交接包，共 ${itemCount} 项，复制下方文本发给另一台机器即可`);
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '导出失败';
  }
}

async function copyExport() {
  if (!exportText.value) return;
  try {
    await navigator.clipboard.writeText(exportText.value);
    flash('ok', '交接包已复制到剪贴板');
  } catch {
    flash('warn', '浏览器禁止了剪贴板访问，请手动全选复制');
  }
}

async function downloadExport() {
  if (!exportText.value) return;
  const blob = new Blob([exportText.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `handover-${deviceId.value.slice(-6)}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function onImportInput() {
  preflight.value = null;
  errorText.value = '';
  const text = importText.value.trim();
  if (!text) return;
  parsing.value = true;
  try {
    const pkg = parseHandoverText(text);
    const count = packageItemCount(pkg);
    const cap = await ensureCapacity(pkg);
    preflight.value = {
      count,
      freeMb: cap.freeBytes !== undefined ? Math.floor(cap.freeBytes / 1024 / 1024) : undefined,
      needMb: cap.needBytes !== undefined ? Math.ceil(cap.needBytes / 1024 / 1024) : undefined,
    };
    if (count > 1000 && !cap.ok) {
      errorText.value = `该包含 ${count} 项（超过 1000），本机容量不足，导入将被拒绝并保留原记录`;
    }
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '解析失败';
  } finally {
    parsing.value = false;
  }
}

async function doImport() {
  errorText.value = '';
  if (!importText.value.trim()) {
    flash('err', '请先粘贴交接包文本');
    return;
  }
  importing.value = true;
  try {
    const pkg = parseHandoverText(importText.value);
    const report = await mergeHandover(pkg);
    syncStore.setLastReport(report);
    if (report.ok) {
      flash('ok', `已合并来自「${report.fromDevice}」的交接包`);
      await shotStore.load();
    } else if (report.reason === 'capacity') {
      flash('err', report.message ?? '本机容量不足，已拒绝导入');
    } else {
      flash('err', report.message ?? '导入失败');
    }
    await syncStore.loadPending();
  } catch (e) {
    flash('err', e instanceof Error ? e.message : '导入失败，原记录保留，可重试');
  } finally {
    importing.value = false;
  }
}

function clearImport() {
  importText.value = '';
  preflight.value = null;
  errorText.value = '';
}

async function handle(action: () => Promise<void>, okText: string) {
  busyId.value = -999;
  try {
    await action();
    await syncStore.loadPending();
    flash('ok', okText);
  } catch (e) {
    flash('err', e instanceof Error ? e.message : '操作失败');
  } finally {
    busyId.value = null;
  }
}

function chooseRemote(entry: PendingEntry) {
  return handle(() => resolveWithRemote(entry), '已采用他机版本，待整理条目已清除');
}
function chooseLocal(entry: PendingEntry) {
  return handle(() => resolveWithLocal(entry), '已保留本机版本，待整理条目已清除');
}
function dropEntry(entry: PendingEntry) {
  return handle(() => discardPending(entry), '已丢弃该待整理条目');
}
async function attachEntry(entry: PendingEntry) {
  const shotId = attachTarget.value[entry.id ?? -1];
  if (typeof shotId !== 'number') {
    flash('err', '请先选择要挂到的镜头');
    return;
  }
  await handle(() => attachOrphanToShot(entry, shotId), '已挂到选定镜头，帧序与实拍剩余已重算');
}
async function fixRange(entry: PendingEntry) {
  const fix = rangeFix.value[entry.id ?? -1];
  if (!fix) {
    flash('err', '请先填写新区间');
    return;
  }
  await handle(() => fixStalePropRange(entry, fix.from, fix.to), '已按新区间重算并清除待整理标记');
}

const report = computed(() => syncStore.lastReport);

function entryShotName(entry: PendingEntry): string {
  return entry.shotCode || entry.remoteShot?.code || '未知镜头';
}

function remoteDisplayValue(entry: PendingEntry): string {
  const r = entry.remote as Record<string, unknown>;
  if (entry.subject === 'frame-exposure') {
    return `曝光 ${r.exposureSec}s · f/${r.aperture} · ISO ${r.iso} · 快门 ${r.shutterAngle}° · ${r.shotCount} 张 · ${r.lighting}`;
  }
  if (entry.subject === 'prop-range') {
    return `区间 ${r.fromFrame} – ${r.toFrame}`;
  }
  if (entry.subject === 'prop-stale') {
    return `区间 ${r.fromFrame} – ${r.toFrame}`;
  }
  return '';
}

function localDisplayValue(entry: PendingEntry): string {
  const l = entry.local as Record<string, unknown> | null;
  if (!l) return '（本机无此条）';
  if (entry.subject === 'frame-exposure') {
    return `曝光 ${l.exposureSec}s · f/${l.aperture} · ISO ${l.iso} · 快门 ${l.shutterAngle}° · ${l.shotCount} 张 · ${l.lighting}`;
  }
  if (entry.subject === 'prop-range') {
    return `区间 ${l.fromFrame} – ${l.toFrame}`;
  }
  if (entry.subject === 'prop-stale') {
    return `区间 ${l.fromFrame} – ${l.toFrame}`;
  }
  return '';
}

const conflicts = computed(() => pending.value.filter((p) => p.kind === 'conflict'));
const orphans = computed(() => pending.value.filter((p) => p.kind === 'orphan'));
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>拍摄交接</h1>
        <p class="sub">两台机器离线轮流记录同一镜头，回网后粘贴交接包合并；冲突并列保留、选定前不改本机数据</p>
      </div>
      <div class="device-card">
        <span class="muted">本机标识</span>
        <input v-model="editingName" class="name-input" maxlength="20" />
        <span class="mono tiny">{{ deviceId }}</span>
        <button type="button" class="btn small" @click="saveName">保存名称</button>
      </div>
    </header>

    <p v-if="notice" class="feedback" :class="notice.type" data-testid="handover-notice">{{ notice.text }}</p>

    <div class="two-panel">
      <!-- 导出 -->
      <div class="panel">
        <div class="panel-head">
          <h2>① 生成交接包</h2>
          <span class="muted">改动带本机标识与顺序号</span>
        </div>
        <p class="muted small">
          全量快照，重复交换会按顺序号自动去重。帧号、道具轨迹、实拍记录都带稳定标识，
          他机拿到的是可合并的增量，而不是整包覆盖。
        </p>
        <div class="actions">
          <button type="button" class="btn primary" data-testid="handover-export" @click="doExport">生成交接包</button>
          <button type="button" class="btn" :disabled="!exportText" @click="copyExport">复制</button>
          <button type="button" class="btn" :disabled="!exportText" @click="downloadExport">下载文件</button>
        </div>
        <textarea
          v-if="exportText"
          class="pack"
          readonly
          rows="10"
          data-testid="handover-export-text"
          :value="exportText"
          @focus="($event.target as HTMLTextAreaElement).select()"
        ></textarea>
        <p v-if="exportMeta" class="muted tiny">共 {{ exportMeta.count }} 项 · 生成于 {{ formatDateTime(exportMeta.at) }}</p>
      </div>

      <!-- 导入 -->
      <div class="panel">
        <div class="panel-head">
          <h2>② 粘贴他机交接包</h2>
          <span class="muted">超过 1000 项先查容量</span>
        </div>
        <textarea
          v-model="importText"
          class="pack"
          rows="10"
          placeholder='粘贴以 {"format":"gbstopmotion-handover" ... 开头的 JSON'
          data-testid="handover-import-text"
          @input="onImportInput"
        ></textarea>
        <p v-if="parsing" class="muted tiny">解析中…</p>
        <div v-else-if="preflight" class="preflight" :class="{ over: preflight.count > 1000 }">
          <span>包内 {{ preflight.count }} 项</span>
          <template v-if="preflight.count > 1000">
            <span v-if="preflight.freeMb !== undefined">本机可用约 {{ preflight.freeMb }} MB · 预计需 {{ preflight.needMb }} MB</span>
            <strong v-if="errorText" class="err">容量不足，将拒绝导入</strong>
          </template>
        </div>
        <p v-if="errorText" class="err small" data-testid="handover-import-error">{{ errorText }}</p>
        <div class="actions">
          <button
            type="button"
            class="btn primary"
            :disabled="importing || !!errorText"
            data-testid="handover-import"
            @click="doImport"
          >
            {{ importing ? '合并中…' : '检查并合并' }}
          </button>
          <button type="button" class="btn" :disabled="importing" @click="clearImport">清空</button>
        </div>
      </div>
    </div>

    <!-- 合并结果 -->
    <div v-if="report" class="panel" data-testid="handover-report">
      <div class="panel-head">
        <h2>③ 合并结果</h2>
        <span class="tag" :class="report.ok ? 'ok' : 'err'">{{ report.ok ? '导入成功' : '未导入（原记录保留）' }}</span>
      </div>
      <div class="report-grid">
        <div class="rep"><span>来源设备</span><strong>{{ report.fromDevice }}</strong></div>
        <div class="rep"><span>新增</span><strong>{{ report.imported.shots + report.imported.frames + report.imported.props + report.imported.takes }} 项</strong></div>
        <div class="rep"><span>更新</span><strong>{{ report.updated.shots + report.updated.frames + report.updated.props + report.updated.takes }} 项</strong></div>
        <div class="rep"><span>跳过（已同步）</span><strong>{{ report.skipped.shots + report.skipped.frames + report.skipped.props + report.skipped.takes }} 项</strong></div>
        <div class="rep"><span>并列冲突</span><strong class="warn">{{ report.conflicts }} 项</strong></div>
        <div class="rep"><span>找不到落点</span><strong class="warn">{{ report.orphans }} 项</strong></div>
      </div>
      <div class="muted tiny">
        镜头 {{ report.imported.shots }}↑{{ report.updated.shots }}≡ · 帧 {{ report.imported.frames }}↑{{ report.updated.frames }}≡ ·
        道具 {{ report.imported.props }}↑{{ report.updated.props }}≡ · 实拍 {{ report.imported.takes }}↑{{ report.updated.takes }}≡
      </div>
      <p v-if="report.frameOrderChanged.length" class="small">
        帧序变化（道具轨迹已检查、实拍剩余张数已同步重算）：{{ report.frameOrderChanged.join('、') }}
      </p>
      <p v-if="report.message" class="err small">{{ report.message }}</p>
    </div>

    <!-- 待整理 -->
    <div class="panel">
      <div class="panel-head">
        <h2>④ 待整理</h2>
        <span class="muted">共 {{ pending.length }} 项 · 冲突 {{ conflicts.length }} · 待挂/失效 {{ orphans.length }}</span>
      </div>

      <EmptyState
        v-if="!pending.length"
        title="没有待整理条目"
        description="两边改动都能自动并入；同一帧曝光或同一道具区间两边都改过时，才会在这里并列等你选定。"
      />

      <div v-else class="pending-list">
        <article v-for="entry in pending" :key="entry.id" class="pending-item" :data-testid="`pending-${entry.id}`">
          <div class="pending-head">
            <span class="tag" :class="entry.kind === 'conflict' ? 'warn' : 'muted'">
              {{ entry.kind === 'conflict' ? '两边都改过' : '找不到落点' }}
            </span>
            <strong>{{ entry.title }}</strong>
            <span class="muted tiny">镜号 {{ entryShotName(entry) }} · 来自 {{ entry.remoteDeviceName || entry.remoteDeviceId }}</span>
          </div>
          <p class="muted tiny">{{ entry.detail }}</p>

          <!-- 冲突：左右并列，选定前本机不动 -->
          <div v-if="entry.kind === 'conflict'" class="compare">
            <div class="side local">
              <div class="side-title">本机（当前保留）</div>
              <div class="side-val">{{ localDisplayValue(entry) }}</div>
              <button type="button" class="btn small" :disabled="busyId !== null" @click="chooseLocal(entry)">采用本机</button>
            </div>
            <div class="side remote">
              <div class="side-title">他机（并列保留）</div>
              <div class="side-val">{{ remoteDisplayValue(entry) }}</div>
              <button type="button" class="btn small primary" :disabled="busyId !== null" data-testid="choose-remote" @click="chooseRemote(entry)">采用他机</button>
            </div>
          </div>

          <!-- 孤儿：挂到镜头 -->
          <div v-else-if="entry.subject.startsWith('orphan-')" class="orphan-row">
            <select v-model.number="attachTarget[entry.id ?? -1]" class="shot-select">
              <option :value="undefined" disabled>选择镜头</option>
              <option v-for="s in shotStore.shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}</option>
            </select>
            <button type="button" class="btn small primary" :disabled="busyId !== null" @click="attachEntry(entry)">挂到该镜头</button>
            <button type="button" class="btn small danger" :disabled="busyId !== null" @click="dropEntry(entry)">丢弃</button>
          </div>

          <!-- 道具区间失效：改区间 -->
          <div v-else-if="entry.subject === 'prop-stale'" class="orphan-row">
            <span class="muted tiny">改成有效区间：</span>
            <input
              type="number"
              min="1"
              class="num"
              :value="rangeFix[entry.id ?? -1]?.from ?? (entry.local as Record<string, unknown>)?.fromFrame"
              @input="rangeFix[entry.id ?? -1] = { ...(rangeFix[entry.id ?? -1] ?? { from: 1, to: 1 }), from: Number(($event.target as HTMLInputElement).value) }"
            />
            <span>–</span>
            <input
              type="number"
              min="1"
              class="num"
              :value="rangeFix[entry.id ?? -1]?.to ?? (entry.local as Record<string, unknown>)?.toFrame"
              @input="rangeFix[entry.id ?? -1] = { ...(rangeFix[entry.id ?? -1] ?? { from: 1, to: 1 }), to: Number(($event.target as HTMLInputElement).value) }"
            />
            <button type="button" class="btn small primary" :disabled="busyId !== null" @click="fixRange(entry)">按新区间重算</button>
            <button type="button" class="btn small" :disabled="busyId !== null" @click="chooseLocal(entry)">确认现状</button>
            <button type="button" class="btn small danger" :disabled="busyId !== null" @click="dropEntry(entry)">丢弃</button>
          </div>
        </article>
      </div>
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
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.device-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-end;
}
.name-input {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  width: 180px;
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
  margin-bottom: 10px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.pack {
  width: 100%;
  box-sizing: border-box;
  margin-top: 10px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  resize: vertical;
  background: #fbfcfe;
  color: #1f2d3d;
}
.preflight {
  margin-top: 8px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #3d4757;
}
.report-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.rep {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #f7f9fc;
  border: 1px solid #eef1f6;
  border-radius: 8px;
  padding: 8px 10px;
}
.rep span {
  font-size: 12px;
  color: #6b7686;
}
.rep strong {
  font-size: 16px;
}
.pending-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pending-item {
  border: 1px solid #e2e7ef;
  border-radius: 8px;
  padding: 12px;
  background: #fbfcfe;
}
.pending-head {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 8px;
}
.side {
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.side.local {
  background: #f5f8ff;
  border: 1px solid #dbe6ff;
}
.side.remote {
  background: #fff8ec;
  border: 1px solid #f2ddae;
}
.side-title {
  font-size: 12px;
  font-weight: 600;
  color: #3d4757;
}
.side-val {
  font-size: 13px;
}
.orphan-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 8px;
}
.shot-select,
.num {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
}
.num {
  width: 80px;
}
.tag {
  display: inline-block;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid transparent;
}
.tag.ok {
  background: #e9f9ef;
  color: #1f8a44;
  border-color: #bfe6cd;
}
.tag.warn {
  background: #fff4df;
  color: #9a6b12;
  border-color: #f0d79c;
}
.tag.err {
  background: #fdecec;
  color: #c45656;
  border-color: #f3c6c6;
}
.tag.muted {
  background: #eef1f6;
  color: #6b7686;
  border-color: #dde3ec;
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
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
.feedback.warn {
  background: #fff8ec;
  border: 1px solid #f0ddb0;
  color: #8a6114;
}
.feedback.err {
  background: #fdecec;
  border: 1px solid #f3c6c6;
  color: #c45656;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.tiny {
  font-size: 11px;
}
.small {
  font-size: 12px;
}
.err {
  color: #c45656;
}
.warn {
  color: #b1740d;
}
</style>
