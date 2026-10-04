/**
 * 交接包导出：把本机（及整包转发时的全部已记录）操作序列化成可粘贴文本。
 */
import * as api from '../db/api';
import { getDeviceId, getDeviceName } from './device';
import { buildPackage, encodePackage } from './package';
import type { HandOp, HandoffPackage } from './types';

export interface ExportOptions {
  /** true = 本机操作；false = 全部已记录操作（含他机导入，供多机整包转发） */
  allDevices?: boolean;
}

export async function buildHandoffPackage(options: ExportOptions = {}): Promise<HandoffPackage> {
  const deviceId = getDeviceId();
  const ops: HandOp[] = options.allDevices
    ? await api.listOps()
    : await api.listOps(deviceId);
  return buildPackage(deviceId, getDeviceName(), ops);
}

export async function exportHandoffText(options: ExportOptions = {}): Promise<string> {
  return encodePackage(await buildHandoffPackage(options));
}
