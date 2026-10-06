import { DomainError } from '../errors.ts';
import type { LeakEvidence } from '../types.ts';
export const DEFAULT_EVIDENCE_WINDOW_MINUTES = 15;
export type WindowedEvidence = LeakEvidence & { eventWindow: string | number };
function compareWindows(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
export function orderEvidence(evidence: LeakEvidence[]): WindowedEvidence[] {
  return evidence.map((item, index) => {
    const time = Date.parse(item.observedAt);
    if (!Number.isFinite(time) || !Number.isFinite(item.logLikelihoodRatio) || !(item.uncertainty > 0) || !Number.isFinite(item.locationM)) throw new DomainError('INVALID_EVIDENCE', 'Leak evidence has invalid time, likelihood, uncertainty or location', 422, { index, item });
    const eventWindow = item.eventWindow ?? Math.floor(time / (DEFAULT_EVIDENCE_WINDOW_MINUTES * 60_000));
    return { ...item, quality: item.quality ?? 'good', eventWindow };
  }).sort((a, b) =>
    compareWindows(a.eventWindow, b.eventWindow)
    || a.locationM - b.locationM
    || a.detectorId.localeCompare(b.detectorId)
    || a.sourceEventId.localeCompare(b.sourceEventId)
    || Date.parse(a.observedAt) - Date.parse(b.observedAt)
    || a.logLikelihoodRatio - b.logLikelihoodRatio
    || a.uncertainty - b.uncertainty);
}
