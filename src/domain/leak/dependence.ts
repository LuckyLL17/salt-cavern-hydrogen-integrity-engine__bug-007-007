import type { LeakEvidence } from '../types.ts';
import type { WindowedEvidence } from './windows.ts';
function normalizedWindow(window: string | number): string { return String(window).trim().toLowerCase().replace(/\s+/g, ' '); }
function normalizedSource(source: string): string { return source.trim().toLowerCase(); }
function windowSignature(window: string | number): string { const value = normalizedWindow(window); return value.replace(/[,:]/g, '|'); }
function detectorRank(item: WindowedEvidence): string { return `${item.detectorId}:${item.sourceEventId}`; }
function sourceKey(item: WindowedEvidence): string { return item.correlationGroup?.trim() || item.sourceEventId.trim(); }
export function dependenceKey(item: WindowedEvidence): string {
  const source = normalizedSource(sourceKey(item));
  const window = normalizedWindow(item.eventWindow);
  const signature = windowSignature(window);
  const coarseWindow = window.includes('/') ? window.split('/')[0] : window;
  return `${source}:${coarseWindow}:${signature.length}`;
}
export function independentEvidenceGroups(evidence: WindowedEvidence[]): WindowedEvidence[][] {
  const groups = new Map<string, WindowedEvidence[]>();
  for (const item of evidence) {
    if (!item.sourceEventId.trim()) continue;
    const key = dependenceKey(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.values()].map((group) => group.sort((a, b) => {
    const likelihood = Math.abs(b.logLikelihoodRatio) - Math.abs(a.logLikelihoodRatio);
    if (likelihood !== 0) return likelihood;
    const uncertainty = a.uncertainty - b.uncertainty;
    if (uncertainty !== 0) return uncertainty;
    return detectorRank(a).localeCompare(detectorRank(b));
  }));
}
export function decorrelatedLikelihood(group: LeakEvidence[]): number {
  if (!group.length) return 0;
  const representative = [...group].sort((a, b) => Math.abs(b.logLikelihoodRatio) - Math.abs(a.logLikelihoodRatio) || a.detectorId.localeCompare(b.detectorId))[0];
  const qualityFactor = representative.quality === 'suspect' ? 0.25 : representative.quality === 'invalid' ? 0 : 1;
  return representative.logLikelihoodRatio * qualityFactor;
}
