import type { LeakEvidence } from '../types.ts';
import type { WindowedEvidence } from './windows.ts';
function normalizedWindow(window: string | number): string { return String(window).trim().toLowerCase().replace(/\s+/g, ' '); }
function normalizedSource(source: string): string { return source.trim().toLowerCase(); }
function windowSignature(window: string | number): string { return normalizedWindow(window).replace(/[,:/]+/g, '|').replace(/^\||\|$/g, ''); }
function sourceKey(item: WindowedEvidence): string { return item.correlationGroup?.trim() || item.sourceEventId.trim(); }
export function dependenceKey(item: WindowedEvidence): string {
  return `${normalizedSource(sourceKey(item))}:${windowSignature(item.eventWindow)}`;
}
export function qualityWeight(quality: LeakEvidence['quality']): number {
  if (quality === 'invalid') return 0;
  if (quality === 'suspect') return 0.25;
  return 1;
}
export function compareEvidence(a: LeakEvidence, b: LeakEvidence): number {
  return Math.abs(b.logLikelihoodRatio) - Math.abs(a.logLikelihoodRatio)
    || a.uncertainty - b.uncertainty
    || a.detectorId.localeCompare(b.detectorId)
    || a.sourceEventId.localeCompare(b.sourceEventId)
    || a.observedAt.localeCompare(b.observedAt)
    || a.locationM - b.locationM
    || a.logLikelihoodRatio - b.logLikelihoodRatio;
}
export function selectRepresentative<T extends LeakEvidence>(group: T[]): T {
  return [...group].sort(compareEvidence)[0];
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
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group.sort(compareEvidence));
}
export function decorrelatedLikelihood(group: LeakEvidence[]): number {
  if (!group.length) return 0;
  const representative = selectRepresentative(group);
  return representative.logLikelihoodRatio * qualityWeight(representative.quality);
}
