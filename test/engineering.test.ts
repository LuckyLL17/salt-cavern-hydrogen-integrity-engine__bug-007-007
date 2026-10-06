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
  assert.equal(result.usedDetectorIds[0], 'mass-balance');
  assert.equal(result.locationM, 100);
});

test('correlated evidence in overlapping windows is independent of order and window notation', () => {
  const evidence = [
    { detectorId: 'mass-balance', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100, eventWindow: '2026-01-01T00:00:00Z,2026-01-01T00:15:00Z' },
    { detectorId: 'pressure-residual', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:05:00Z', logLikelihoodRatio: 1.8, uncertainty: 1.2, locationM: 102, eventWindow: '2026-01-01T00:05:00Z/2026-01-01T00:20:00Z' },
    { detectorId: 'duplicate-residual', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:06:00Z', logLikelihoodRatio: 1.7, uncertainty: 1.2, locationM: 102, eventWindow: '2026-01-01T00:06:00Z:2026-01-01T00:21:00Z' },
    { detectorId: 'acoustic', sourceEventId: 'raw-2', observedAt: '2026-01-01T01:00:00Z', logLikelihoodRatio: 1, uncertainty: 1, locationM: 120 },
  ];
  const first = fuseLeakEvidence(evidence);
  const reversed = fuseLeakEvidence([...evidence].reverse());
  assert.equal(first.evidenceGroups, 2);
  assert.deepEqual(first, reversed);
  assert.deepEqual(first.usedDetectorIds, ['mass-balance', 'acoustic']);
});

test('only overlapping windows from one correlated group are fused once', () => {
  const make = (start: string, end: string, detectorId: string, ratio: number) => ({
    detectorId, sourceEventId: 'raw-1', observedAt: start, logLikelihoodRatio: ratio, uncertainty: 1, locationM: 100,
    eventWindow: { start, end },
  });
  const priorLogOdds = Math.log(0.01 / 0.99);
  const adjacent = fuseLeakEvidence([
    make('2026-01-01T00:00:00Z', '2026-01-01T00:15:00Z', 'a', 2),
    make('2026-01-01T00:15:00Z', '2026-01-01T00:30:00Z', 'b', 1),
  ]);
  const overlapping = fuseLeakEvidence([
    make('2026-01-01T00:00:00Z', '2026-01-01T00:15:00Z', 'a', 2),
    make('2026-01-01T00:14:59Z', '2026-01-01T00:30:00Z', 'b', 1),
  ]);
  assert.equal(adjacent.evidenceGroups, 2);
  assert.ok(Math.abs(adjacent.probability - 1 / (1 + Math.exp(-(priorLogOdds + 3)))) < 1e-12);
  assert.equal(overlapping.evidenceGroups, 1);
  assert.ok(Math.abs(overlapping.probability - 1 / (1 + Math.exp(-(priorLogOdds + 2)))) < 1e-12);
});

test('non-overlapping label windows with equal coarse prefix stay independent', () => {
  const result = fuseLeakEvidence([
    { detectorId: 'a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100, eventWindow: 'shift-a/window-1' },
    { detectorId: 'b', sourceEventId: 'raw-1', observedAt: '2026-01-02T00:00:00Z', logLikelihoodRatio: 1, uncertainty: 1, locationM: 110, eventWindow: 'shift-a/window-2' },
  ]);
  assert.equal(result.evidenceGroups, 2);
});

test('quality is applied once per correlated evidence group', () => {
  const good = fuseLeakEvidence([
    { detectorId: 'a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 2, uncertainty: 1, locationM: 100, eventWindow: '2026-01-01T00:00:00Z/PT15M' },
    { detectorId: 'b', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:05:00Z', logLikelihoodRatio: 1.9, uncertainty: 1, locationM: 110, eventWindow: '2026-01-01T00:05:00Z/PT15M', quality: 'suspect' },
  ]);
  const suspect = fuseLeakEvidence([
    { detectorId: 'a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 1.9, uncertainty: 1, locationM: 100, eventWindow: '2026-01-01T00:00:00Z/PT15M', quality: 'suspect' },
    { detectorId: 'b', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:05:00Z', logLikelihoodRatio: 1.8, uncertainty: 1, locationM: 100, eventWindow: '2026-01-01T00:05:00Z/PT15M', quality: 'suspect' },
  ]);
  const invalid = fuseLeakEvidence([
    { detectorId: 'a', sourceEventId: 'raw-1', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 1.9, uncertainty: 1, locationM: 100, eventWindow: '2026-01-01T00:00:00Z/PT15M', quality: 'invalid' },
  ]);
  const priorLogOdds = Math.log(0.01 / 0.99);
  assert.ok(Math.abs(good.probability - 1 / (1 + Math.exp(-(priorLogOdds + 2)))) < 1e-12);
  assert.equal(good.locationM, 100);
  assert.ok(Math.abs(suspect.probability - 1 / (1 + Math.exp(-(priorLogOdds + 1.9 * 0.25)))) < 1e-12);
  assert.ok(Math.abs(invalid.probability - 0.01) < 1e-12);
  const mixed = fuseLeakEvidence([
    { detectorId: 'strong-invalid', sourceEventId: 'raw-2', observedAt: '2026-01-01T00:00:00Z', logLikelihoodRatio: 5, uncertainty: 1, locationM: 100, eventWindow: '2026-01-01T00:00:00Z/PT15M', quality: 'invalid' },
    { detectorId: 'weak-valid', sourceEventId: 'raw-2', observedAt: '2026-01-01T00:01:00Z', logLikelihoodRatio: 1, uncertainty: 1, locationM: 101, eventWindow: '2026-01-01T00:01:00Z/PT15M', quality: 'good' },
  ]);
  assert.ok(Math.abs(mixed.probability - 0.01) < 1e-12);
  assert.equal(mixed.locationM, 0);
  assert.deepEqual(mixed.usedDetectorIds, ['strong-invalid']);
});

test('uncertainty samples are reproducible for a fixed seed', () => {
  const input = { mean: { porosity: 0.2, creepCoefficient: 1, geometryScale: 1 }, standardDeviation: { porosity: 0.01, creepCoefficient: 0.1, geometryScale: 0.02 }, correlation: [[1, 0.6, 0.1], [0.6, 1, 0.2], [0.1, 0.2, 1]], sampleCount: 20, seed: 7 };
  assert.deepEqual(sampleParameters(input), sampleParameters(input));
});
