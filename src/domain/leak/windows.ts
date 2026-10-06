import { DomainError } from '../errors.ts';
import type { LeakEvidence, LeakEvidenceQuality } from '../types.ts';

export const DEFAULT_EVIDENCE_WINDOW_MINUTES = 15;
const DEFAULT_WINDOW_MS = DEFAULT_EVIDENCE_WINDOW_MINUTES * 60_000;

export type EvidenceWindowInput = number | string | { start: number | string; end: number | string };
export type WindowedEvidence = LeakEvidence & {
  eventWindow: number | string;
  windowKind: 'bucket' | 'time' | 'label';
  windowStart: number;
  windowEnd: number;
  windowDiscrete: boolean;
  windowKey: string;
};

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeInstant(value: string): string | null {
  const text = normalizeText(value).replace(/[ _]+/g, 'T');
  const compact = /^(\d{8})t(\d{2})(\d{2})(\d{2})(z|[+-]\d{4})?$/.exec(text);
  if (compact) {
    const [, date, hour, minute, second, zone = 'z'] = compact;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hour}:${minute}:${second}${zone.toUpperCase()}`;
  }
  return text;
}

function parseInstant(value: string): number | null {
  const normalized = normalizeInstant(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDurationMs(value: string): number | null {
  const match = /^([+-])?p(?:(\d+(?:\.\d+)?)d)?(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/.exec(normalizeText(value));
  if (!match) return null;
  const days = Number(match[2] ?? 0);
  const hours = Number(match[3] ?? 0);
  const minutes = Number(match[4] ?? 0);
  const seconds = Number(match[5] ?? 0);
  if (!match[2] && !match[3] && !match[4] && !match[5]) return null;
  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1_000;
  return ms * (match[1] === '-' ? -1 : 1);
}

function intervalText(value: string): string {
  const text = normalizeText(value).replace(/[ _]+/g, 'T');
  const comma = text.search(/,(?=\d{4}-\d{2}-\d{2}|t?\d{2}:\d{2}|p\d)/i);
  if (comma > 0) return `${text.slice(0, comma)}/${text.slice(comma + 1)}`;

  // A colon is also accepted at the boundary between a complete date-time and
  // another date-time. Scan after each time field so the value's own colons are
  // not treated as separators.
  const boundary = /\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?:/y;
  let index = 0;
  while (index < text.length) {
    boundary.lastIndex = index;
    const match = boundary.exec(text);
    if (!match) break;
    const boundaryIndex = match.index + match[0].length - 1;
    const following = text.slice(boundaryIndex + 1);
    if (/^\d{4}-\d{2}-\d{2}|^[Tt]?\d{2}:\d{2}|^[Pp]/.test(following)) return `${text.slice(0, boundaryIndex)}/${following}`;
    index = match.index + 1;
  }
  return text;
}

export function canonicalEvidenceWindow(window: EvidenceWindowInput | undefined, observedAt?: string): Pick<WindowedEvidence, 'eventWindow' | 'windowKind' | 'windowStart' | 'windowEnd' | 'windowDiscrete' | 'windowKey'> {
  if (window === undefined) {
    const time = parseInstant(observedAt ?? '');
    if (time === null) throw new DomainError('INVALID_EVIDENCE', 'Leak evidence has an invalid observation time', 422);
    const bucket = Math.floor(time / DEFAULT_WINDOW_MS);
    return { eventWindow: bucket, windowKind: 'bucket', windowStart: bucket, windowEnd: bucket, windowDiscrete: true, windowKey: `bucket:${bucket}` };
  }
  if (typeof window === 'number' && Number.isFinite(window)) {
    const index = Math.trunc(window);
    return { eventWindow: index, windowKind: 'bucket', windowStart: index, windowEnd: index, windowDiscrete: true, windowKey: `bucket:${index}` };
  }
  if (typeof window !== 'string' && typeof window !== 'object') {
    throw new DomainError('INVALID_EVIDENCE', 'Leak evidence observation window must be a number, string or interval', 422);
  }
  if (typeof window === 'object') {
    if (window === null || Array.isArray(window) || (typeof window.start !== 'number' && typeof window.start !== 'string') || (typeof window.end !== 'number' && typeof window.end !== 'string')) {
      throw new DomainError('INVALID_EVIDENCE', 'Leak evidence observation window must be a number, string or interval', 422);
    }
  }

  let text: string;
  let startInput: string | number;
  let endInput: string | number | undefined;
  if (typeof window === 'string') {
    text = intervalText(window);
    const slash = text.indexOf('/');
    if (slash < 0) {
      const label = normalizeText(text);
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(label)) {
        const index = Math.trunc(Number(label));
        return { eventWindow: index, windowKind: 'bucket', windowStart: index, windowEnd: index, windowDiscrete: true, windowKey: `bucket:${index}` };
      }
      const point = parseInstant(label);
      if (point !== null) return { eventWindow: label, windowKind: 'time', windowStart: point, windowEnd: point, windowDiscrete: false, windowKey: `time:${point}` };
      const bucket = /^bucket:([+-]?\d+)$/.exec(label);
      if (bucket) {
        const index = Number(bucket[1]);
        return { eventWindow: index, windowKind: 'bucket', windowStart: index, windowEnd: index, windowDiscrete: true, windowKey: `bucket:${index}` };
      }
      return { eventWindow: label, windowKind: 'label', windowStart: NaN, windowEnd: NaN, windowDiscrete: false, windowKey: `label:${label}` };
    }
    if (parseInstant(text.slice(0, slash)) === null) {
      const label = normalizeText(text);
      return { eventWindow: label, windowKind: 'label', windowStart: NaN, windowEnd: NaN, windowDiscrete: false, windowKey: `label:${label}` };
    }
    startInput = text.slice(0, slash);
    endInput = text.slice(slash + 1);
  } else {
    startInput = window.start;
    endInput = window.end;
    text = `${String(startInput)}/${String(endInput ?? '')}`;
  }

  if (typeof startInput === 'number' || typeof endInput === 'number') {
    if (typeof startInput !== 'number' || typeof endInput !== 'number' || !Number.isFinite(startInput) || !Number.isFinite(endInput)) {
      throw new DomainError('INVALID_EVIDENCE', 'Leak evidence observation window interval must contain finite endpoints', 422);
    }
    return { eventWindow: `${startInput}/${endInput}`, windowKind: 'time', windowStart: startInput, windowEnd: endInput, windowDiscrete: false, windowKey: `time-interval:${startInput}/${endInput}` };
  }

  const start = parseInstant(startInput);
  if (start === null) throw new DomainError('INVALID_EVIDENCE', 'Leak evidence observation window has an invalid start', 422, { window: text });
  let end = parseInstant(endInput ?? '');
  if (end === null) {
    const duration = parseDurationMs(endInput ?? '');
    if (duration === null) throw new DomainError('INVALID_EVIDENCE', 'Leak evidence observation window has an invalid end or duration', 422, { window: text });
    end = start + duration;
  }
  if (!Number.isFinite(end) || end < start) throw new DomainError('INVALID_EVIDENCE', 'Leak evidence observation window must end after it starts', 422, { window: text });
  return { eventWindow: `${start}/${end}`, windowKind: 'time', windowStart: start, windowEnd: end, windowDiscrete: false, windowKey: `time-interval:${start}/${end}` };
}

export function orderEvidence(evidence: LeakEvidence[]): WindowedEvidence[] {
  return evidence.map((item, index) => {
    const time = Date.parse(item.observedAt);
    if (!Number.isFinite(time) || !Number.isFinite(item.logLikelihoodRatio) || !(item.uncertainty > 0) || !Number.isFinite(item.locationM)) throw new DomainError('INVALID_EVIDENCE', 'Leak evidence has invalid time, likelihood, uncertainty or location', 422, { index, item });
    const quality: LeakEvidenceQuality = item.quality ?? 'good';
    if (quality !== 'good' && quality !== 'suspect' && quality !== 'invalid') throw new DomainError('INVALID_EVIDENCE', 'Leak evidence quality must be good, suspect or invalid', 422, { index, item });
    const window = canonicalEvidenceWindow((item as { eventWindow?: EvidenceWindowInput }).eventWindow, item.observedAt);
    return { ...item, quality, ...window };
  }).sort((a, b) =>
    a.windowStart - b.windowStart ||
    a.windowEnd - b.windowEnd ||
    a.windowKey.localeCompare(b.windowKey) ||
    a.locationM - b.locationM ||
    a.detectorId.localeCompare(b.detectorId) ||
    a.sourceEventId.localeCompare(b.sourceEventId),
  );
}
