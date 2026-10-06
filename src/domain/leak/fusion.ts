import { orderEvidence } from './windows.ts';
import { independentEvidenceGroups, qualityFactor, representativeEvidence } from './dependence.ts';
import { posteriorProbability } from './bayes.ts';
import { combineRepresentativeLocations } from './localization.ts';
import type { LeakEvidence } from '../types.ts';

export type LeakAssessment = { probability: number; locationM: number; evidenceGroups: number; eventIds: string[]; usedDetectorIds: string[] };

export function fuseLeakEvidence(evidence: LeakEvidence[], priorProbability = 0.01): LeakAssessment {
  const ordered = orderEvidence(evidence);
  const groups = independentEvidenceGroups(ordered);
  const representatives = groups.map(representativeEvidence);
  const probability = posteriorProbability(priorProbability, representatives.map((item) => item.logLikelihoodRatio * qualityFactor(item.quality)));
  return {
    probability,
    locationM: combineRepresentativeLocations(representatives),
    evidenceGroups: groups.length,
    eventIds: [...new Set(ordered.map((item) => item.sourceEventId))].sort(),
    usedDetectorIds: representatives.map((item) => item.detectorId),
  };
}
