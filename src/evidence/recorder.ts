// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Evidence images for a scan (report v2): hands out ids, enforces the per-scan cap and passes the
// bytes to the sink. Probes and the evidence pass share one recorder per scan. Engine core: no
// Node-only imports.
import type { EvidenceBox, EvidenceOptions, EvidenceShot } from '../types.js';

export const DEFAULT_MAX_IMAGES = 16;
export const MAX_IMAGES_LIMIT = 40;

/**
 * Where a shot comes from. Probes may use at most `probeShare` of the cap, so the evidence pass always
 * has room. 'ai' (scoring v5): pictures of the AI image failures that count toward the score; the
 * recorder keeps `aiReserve` slots that only they can use.
 */
export type EvidencePool = 'probe' | 'pass' | 'ai';

/** Slots kept for the pictures of scored AI image failures when the scan has an AI review (one per scored kind). */
export const AI_EVIDENCE_RESERVE = 2;

export interface EvidenceRecorder {
  /** Slots left in `pool` now. */
  room(pool: EvidencePool): number;
  /**
   * Records a shot: assigns its id, sends the bytes to the sink and keeps the metadata. Returns the
   * shot, or null when the pool is full or the sink threw (the scan never fails on evidence).
   */
  add(shot: Omit<EvidenceShot, 'id'>, jpeg: Uint8Array, pool: EvidencePool): Promise<EvidenceShot | null>;
  /** Every recorded shot, in id order. */
  shots(): EvidenceShot[];
  /** Appends callout boxes to the recorded shot `id` (the start page's core-test marks). False when there is no such shot. */
  addBoxes(id: string, boxes: readonly EvidenceBox[]): boolean;
}

export function createEvidenceRecorder(opts: EvidenceOptions, probeShare = 0.5, aiReserve = 0): EvidenceRecorder {
  const max = Math.min(Math.max(Math.floor(opts.maxImages ?? DEFAULT_MAX_IMAGES), 1), MAX_IMAGES_LIMIT);
  const probeMax = Math.floor(max * probeShare);
  // The reserve never takes more than half the cap.
  const reserve = Math.max(0, Math.min(Math.floor(aiReserve), Math.floor(max / 2)));
  const kept: EvidenceShot[] = [];
  let next = 1;
  let probeUsed = 0;
  let aiUsed = 0;
  // Slots are claimed before the (async) sink call so parallel adds never overshoot the cap.
  let claimed = 0;
  const free = () => Math.max(0, max - claimed);
  // What the other pools may use: the free slots minus the part of the AI reserve not used yet.
  const shared = () => Math.max(0, free() - Math.max(0, reserve - aiUsed));
  const room = (pool: EvidencePool) =>
    pool === 'ai' ? free() : pool === 'probe' ? Math.max(0, Math.min(probeMax - probeUsed, shared())) : shared();
  return {
    room,
    async add(shot, jpeg, pool) {
      if (room(pool) <= 0) return null;
      claimed++;
      if (pool === 'probe') probeUsed++;
      if (pool === 'ai') aiUsed++;
      const id = `e${next++}`;
      try {
        await opts.sink(id, jpeg);
      } catch {
        // A sink failure drops this image only; the slot stays used so ids remain unique.
        return null;
      }
      const full: EvidenceShot = { id, ...shot };
      kept.push(full);
      return full;
    },
    shots: () => [...kept].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    addBoxes(id, boxes) {
      const i = kept.findIndex((s) => s.id === id);
      if (i < 0) return false;
      kept[i] = { ...kept[i]!, boxes: [...kept[i]!.boxes, ...boxes] };
      return true;
    },
  };
}
