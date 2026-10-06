import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComposition } from '../src/domain/composition.ts';
import { emptyInventory, applyTransfer, inventorySummary } from '../src/domain/inventory-ledger.ts';
import { cavernVolumeM3, volumeToDepthM3 } from '../src/domain/cavern-geometry.ts';
import { allocateSharedCapacity } from '../src/domain/facility-dispatch.ts';
import { advanceGeoHistory, initialGeoState } from '../src/domain/geomechanics.ts';
import { correctSample } from '../src/domain/monitoring.ts';
import { fuseLeakEvidence } from '../src/domain/leak-detection.ts';
import { sampleParameters } from '../src/domain/uncertainty.ts';

test('composition normalization returns a closed mole-fraction vector', () => {
  const c = normalizeComposition({ H2: 2, CH4: 1 });
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 1);
  assert.ok(c.H2 > c.CH4);
});

test('inventory transfer is idempotent by business transfer id', () => {
  const state = applyTransfer(emptyInventory(), { id: 't-1', direction: 'inject', amount: 100, unit: 'mol', composition: { H2: 1 } });
  assert.equal(inventorySummary(applyTransfer(state, { id: 't-1', direction: 'inject', amount: 100, unit: 'mol', composition: { H2: 1 } })).totalMoles, 100);
});

test('measured geometry produces increasing partial cavern volume', () => {
  const points = [{ depthM: 100, radiusM: 2 }, { depthM: 120, radiusM: 3 }, { depthM: 150, radiusM: 2.5 }];
  assert.ok(cavernVolumeM3(points) > volumeToDepthM3(points, 125));
  assert.ok(volumeToDepthM3(points, 125) > 0);
});

test('facility allocation respects a shared station cap', () => {
  const result = allocateSharedCapacity([
    { cavernId: 'A', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 2 },
    { cavernId: 'B', requestedMolPerSecond: 8, minimumMolPerSecond: 1, priority: 1 },
  ], 10);
  assert.ok(result.reduce((sum, item) => sum + item.allocatedMolPerSecond, 0) <= 10);
});

test('geomechanical state accumulates across sequential intervals', () => {
  const p = { referencePressureKpa: 20_000, damageExponent: 2, creepCoefficientPerHour: 1e-5, recoveryPerHour: 1e-6, maxDamage: 0.9 };
  const one = advanceGeoHistory(initialGeoState(), [{ durationHours: 100, pressureKpa: 15_000, temperatureK: 310, resting: false }], p);
  const two = advanceGeoHistory(initialGeoState(), [{ durationHours: 100, pressureKpa: 15_000, temperatureK: 310, resting: false }, { durationHours: 100, pressureKpa: 15_000, temperatureK: 310, resting: false }], p);
  assert.ok(two.cumulativeDamage > one.cumulativeDamage);
});

test('monitoring calibration is resolved by effective sample time', () => {
  const result = correctSample({ sensorId: 'p-1', observedAt: '2026-01-02T00:00:00Z', value: 10, quality: 'good', unit: 'kPa' }, [
    { id: 'old', sensorId: 'p-1', validFrom: '2025-01-01T00:00:00Z', validTo: '2026-06-01T00:00:00Z', offset: 1, scale: 1, uncertainty: 0.1, createdAt: '2025-01-01T00:00:00Z' },
    { id: 'new', sensorId: 'p-1', validFrom: '2026-06-01T00:00:00Z', offset: 3, scale: 1, uncertainty: 0.2, createdAt: '2026-06-01T00:00:00Z' },
  ]);
  assert.equal(result.calibrationId, 'old');
});

test('reused leak evidence is grouped once', () => {
  const result = fuseLeakEvidence([
    { detectorId: 'mass-balance', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100 },
    { detectorId: 'pressure-residual', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 1.8, uncertainty: 1.2, locationM: 102 },
  ]);
  assert.equal(result.evidenceGroups, 1);
});

test('leak evidence grouping is stable across window formats', () => {
  const formats: Array<string | number> = [19723, '19723', '2026-01-01 00:00/2026-01-01 00:15', '2026-01-01 00:00,2026-01-01 00:15'];
  const assessments = formats.map((eventWindow) => fuseLeakEvidence([
    { detectorId: 'det-a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:05:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100, eventWindow },
    { detectorId: 'det-b', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:06:00Z', logLikelihoodRatio: 1.5, uncertainty: 1, locationM: 102, eventWindow },
  ]));
  for (const assessment of assessments) {
    assert.equal(assessment.evidenceGroups, 1);
    assert.deepEqual(assessment, assessments[0]);
  }
});

test('leak fusion does not depend on evidence input order', () => {
  const evidence = [
    { detectorId: 'det-a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100, quality: 'good' as const },
    { detectorId: 'det-b', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:01:00Z', logLikelihoodRatio: 1.5, uncertainty: 0.8, locationM: 104, quality: 'suspect' as const },
    { detectorId: 'det-c', sourceEventId: 'raw-2', observedAt: '2026-01-01T01:00:00Z', logLikelihoodRatio: -1, uncertainty: 2, locationM: 250 },
    { detectorId: 'det-a', sourceEventId: 'raw-2', observedAt: '2026-01-01T01:02:00Z', logLikelihoodRatio: 1.2, uncertainty: 1.5, locationM: 240 },
  ];
  const forward = fuseLeakEvidence(evidence);
  const reversed = fuseLeakEvidence([...evidence].reverse());
  const rotated = fuseLeakEvidence([...evidence.slice(2), ...evidence.slice(0, 2)]);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(rotated, forward);
});

test('leak fusion selects one representative per correlated group', () => {
  const result = fuseLeakEvidence([
    { detectorId: 'det-b', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 0.5, locationM: 100, quality: 'good' },
    { detectorId: 'det-a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100, quality: 'suspect' },
  ]);
  const logOdds = (probability: number) => Math.log(probability / (1 - probability));
  assert.equal(result.usedDetectorIds[0], 'det-b');
  assert.ok(Math.abs(logOdds(result.probability) - logOdds(0.01) - 2) < 1e-12);
});

test('leak fusion down-weights suspect and ignores invalid evidence consistently', () => {
  const logOdds = (probability: number) => Math.log(probability / (1 - probability));
  const suspect = fuseLeakEvidence([
    { detectorId: 'det-a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 4, uncertainty: 1, locationM: 100, quality: 'suspect' },
  ]);
  assert.ok(Math.abs(logOdds(suspect.probability) - logOdds(0.01) - 1) < 1e-12);
  const mixed = fuseLeakEvidence([
    { detectorId: 'det-a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 4, uncertainty: 0.1, locationM: 500, quality: 'invalid' },
    { detectorId: 'det-b', sourceEventId: 'raw-2', observedAt: '2026-01-01T01:00:00Z', logLikelihoodRatio: 1, uncertainty: 1, locationM: 100 },
  ]);
  assert.ok(Math.abs(logOdds(mixed.probability) - logOdds(0.01) - 1) < 1e-12);
  assert.equal(mixed.locationM, 100);
});

test('only independent leak windows accumulate likelihood', () => {
  const logOdds = (probability: number) => Math.log(probability / (1 - probability));
  const result = fuseLeakEvidence([
    { detectorId: 'det-a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100 },
    { detectorId: 'det-b', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:30:00Z', logLikelihoodRatio: 3, uncertainty: 1, locationM: 100 },
  ]);
  assert.equal(result.evidenceGroups, 2);
  assert.ok(Math.abs(logOdds(result.probability) - logOdds(0.01) - 5) < 1e-12);
});

test('uncertainty samples are reproducible for a fixed seed', () => {
  const input = { mean: { porosity: 0.2, creepCoefficient: 1, geometryScale: 1 }, standardDeviation: { porosity: 0.01, creepCoefficient: 0.1, geometryScale: 0.02 }, correlation: [[1, 0.6, 0.1], [0.6, 1, 0.2], [0.1, 0.2, 1]], sampleCount: 20, seed: 7 };
  assert.deepEqual(sampleParameters(input), sampleParameters(input));
});
