import { qualityFactor, representativeEvidence } from './dependence.ts';
import type { LeakEvidence } from '../types.ts';

function evidenceWeight(item: LeakEvidence): number {
  return qualityFactor(item.quality) / item.uncertainty ** 2;
}

export function weightedMedianLocation(group: LeakEvidence[]): number {
  const ordered = [...group].sort((a, b) => a.locationM - b.locationM);
  const totalWeight = ordered.reduce((sum, item) => sum + evidenceWeight(item), 0);
  if (totalWeight === 0) return 0;
  let accumulated = 0;
  for (const item of ordered) {
    accumulated += evidenceWeight(item);
    if (accumulated >= totalWeight / 2) return item.locationM;
  }
  return representativeEvidence(ordered).locationM;
}

export function combineRepresentativeLocations(representatives: LeakEvidence[]): number {
  const weighted = representatives
    .map((item) => ({ value: item.locationM, weight: evidenceWeight(item) }))
    .filter((item) => item.weight > 0);
  const sumWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  return sumWeight === 0 ? 0 : weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / sumWeight;
}

export function combineLocations(groups: LeakEvidence[][]): number {
  return combineRepresentativeLocations(groups.map(representativeEvidence));
}
