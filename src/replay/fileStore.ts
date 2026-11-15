// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The snapshot store in a folder (the CLI, tests, a snapshot kept for a dispute): one file per record
// and per distinct body. Node only: its imports are made when it is used, so the module itself loads
// anywhere (the Worker bundles the engine).
import type { SnapshotStore } from './snapshot.js';

/** Ids are `r/<n>` and `b/<sha-256>`: anything else never becomes a path. */
const SAFE_ID = /^(?:r\/\d{1,12}|b\/[0-9a-f]{64}|index)$/;

/**
 * A store in `dir` (made if missing). `clear` removes the folder with everything in it, so `dir` must be
 * the snapshot's own.
 */
export async function fileStore(dir: string): Promise<SnapshotStore> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(dir);
  await fs.mkdir(path.join(root, 'r'), { recursive: true });
  await fs.mkdir(path.join(root, 'b'), { recursive: true });
  const file = (id: string): string => {
    if (!SAFE_ID.test(id)) throw new Error('Not a snapshot id');
    return path.join(root, ...id.split('/'));
  };
  return {
    async put(id, bytes) {
      await fs.writeFile(file(id), bytes);
    },
    async get(id) {
      try {
        return new Uint8Array(await fs.readFile(file(id)));
      } catch {
        return undefined;
      }
    },
    async clear() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
