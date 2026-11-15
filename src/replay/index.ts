// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Record once, test on the copy (docs/record-replay.md).
import type { ReplayMode } from './browser.js';

export { createReplay, REPLAY_MARK, type Replay, type ReplayMode, type ReplayOptions } from './browser.js';
export { byteRange, createSnapshot, memoryStore, replayUrl, REPLAY_DEFAULTS, SNAPSHOT_ASSUMPTIONS, type ReplayHit, type ReplayRequest, type ReplayStats, type Snapshot, type SnapshotOptions, type SnapshotStore } from './snapshot.js';
export { fileStore } from './fileStore.js';

/** Measurement commits only (never merged): replay without the environment variable. */
const ALWAYS: ReplayMode = 'off';

/**
 * The mode asked for from outside the code, for the scans that do not say (`ScanOptions.replay` absent):
 * GRNTED_REPLAY=record-replay turns it on for a whole test run (the fidelity proof runs every suite both
 * ways). Such a scan prints one line when it ends, `GRNTED_REPLAY {stats}`, so a run that was meant to
 * replay and did not is seen. A host that passes `replay` (the Worker always does) never reads this.
 */
export function envReplay(): ReplayMode | undefined {
  if (ALWAYS !== 'off') return ALWAYS;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.GRNTED_REPLAY === 'record-replay' ? 'record-replay' : undefined;
}
