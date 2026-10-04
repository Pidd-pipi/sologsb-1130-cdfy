/** 拍摄交接 store：设备标识、待整理列表、导出/导入结果状态 */
import { defineStore } from 'pinia';
import { getDevice, setDeviceName } from '../utils/device';
import * as api from '../db/api';
import type { MergeReport } from '../types/sync';
import type { PendingEntry } from '../types/sync';

interface SyncState {
  deviceId: string;
  deviceName: string;
  pending: PendingEntry[];
  lastReport: MergeReport | null;
}

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    deviceId: '',
    deviceName: '',
    pending: [],
    lastReport: null,
  }),
  getters: {
    pendingCount(state): number {
      return state.pending.length;
    },
    conflictCount(state): number {
      return state.pending.filter((p) => p.kind === 'conflict').length;
    },
    orphanCount(state): number {
      return state.pending.filter((p) => p.kind === 'orphan').length;
    },
  },
  actions: {
    initDevice() {
      const d = getDevice();
      this.deviceId = d.deviceId;
      this.deviceName = d.deviceName;
    },
    renameDevice(name: string) {
      setDeviceName(name);
      this.initDevice();
    },
    async loadPending() {
      this.pending = await api.listPending();
    },
    setLastReport(report: MergeReport | null) {
      this.lastReport = report;
    },
  },
});
