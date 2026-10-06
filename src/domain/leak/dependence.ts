import type { LeakEvidence, LeakEvidenceQuality } from '../types.ts';
import type { WindowedEvidence } from './windows.ts';

function normalizedSource(source: string): string { return source.trim().toLowerCase(); }
function sourceKey(item: WindowedEvidence): string { return item.correlationGroup?.trim() || item.sourceEventId.trim(); }
function correlationSource(item: WindowedEvidence): string { return normalizedSource(sourceKey(item)); }
export function qualityRank(quality: LeakEvidenceQuality | undefined): number {
  return quality === 'good' ? 0 : quality === 'suspect' ? 1 : 2;
}

export function compareEvidenceCandidates(a: WindowedEvidence | LeakEvidence, b: WindowedEvidence | LeakEvidence): number {
  const likelihood = Math.abs(b.logLikelihoodRatio) - Math.abs(a.logLikelihoodRatio);
  if (likelihood !== 0) return likelihood;
  const uncertainty = a.uncertainty - b.uncertainty;
  if (uncertainty !== 0) return uncertainty;
  const detector = a.detectorId.localeCompare(b.detectorId);
  if (detector !== 0) return detector;
  const source = a.sourceEventId.localeCompare(b.sourceEventId);
  if (source !== 0) return source;
  const location = a.locationM - b.locationM;
  if (location !== 0) return location;
  const observed = a.observedAt.localeCompare(b.observedAt);
  if (observed !== 0) return observed;
  return qualityRank(a.quality ?? 'good') - qualityRank(b.quality ?? 'good');
}

function overlaps(a: WindowedEvidence, b: WindowedEvidence): boolean {
  const finite = Number.isFinite(a.windowStart) && Number.isFinite(a.windowEnd) && Number.isFinite(b.windowStart) && Number.isFinite(b.windowEnd);
  if (!finite) return false;
  if (a.windowDiscrete || b.windowDiscrete) {
    return a.windowDiscrete && b.windowDiscrete && a.windowStart === b.windowStart && a.windowEnd === b.windowEnd;
  }
  return a.windowKind === b.windowKind && a.windowStart < b.windowEnd && b.windowStart < a.windowEnd;
}

export function dependenceKey(item: WindowedEvidence): string {
  return `${correlationSource(item)}:${item.windowKey}`;
}

export function independentEvidenceGroups(evidence: WindowedEvidence[]): WindowedEvidence[][] {
  const groups = new Map<string, { source: string; key: string; items: WindowedEvidence[] }>();

  for (const item of evidence) {
    if (!item.sourceEventId.trim()) continue;
    const source = correlationSource(item);
    const key = dependenceKey(item);
    const related = [...groups.values()].filter((group) => {
      if (group.source !== source) return false;
      if (group.key === key) return true;
      return item.windowKind !== 'label' && group.items.some((candidate) => overlaps(item, candidate));
    });

    if (related.length) {
      const first = related[0];
      first.items.push(item);
      for (const other of related.slice(1)) {
        first.items.push(...other.items);
        groups.delete(other.key);
      }
    } else {
      groups.set(key, { source, key, items: [item] });
    }
  }

  return [...groups.values()]
    .map((group) => group.items.sort(compareEvidenceCandidates))
    .sort((a, b) => compareEvidenceCandidates(a[0], b[0]));
}

export function representativeEvidence(group: LeakEvidence[]): LeakEvidence {
  if (!group.length) throw new Error('Cannot select representative from an empty evidence group');
  return [...group].sort(compareEvidenceCandidates)[0];
}

export function qualityFactor(quality: LeakEvidenceQuality | undefined): number {
  return quality === 'suspect' ? 0.25 : quality === 'invalid' ? 0 : 1;
}

export function decorrelatedLikelihood(group: LeakEvidence[]): number {
  const representative = representativeEvidence(group);
  return representative.logLikelihoodRatio * qualityFactor(representative.quality);
}
