// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness: a site built with Astro showed "Unknown", so the fix brief asked the AI which platform
// it is. Astro is named from its documented signs only: the generator tag Astro.generator writes ("Astro v5.x.x",
// docs.astro.build API reference), the data-astro-cid-* attributes its scoped styles put on elements (the default
// scopedStyleStrategy 'attribute', docs.astro.build styling guide), and its build assets under /_astro/ (the default
// build.assets) on the site's own host.
import { describe, expect, it } from 'vitest';
import { decidePlatform, platformGuidance, PLATFORMS, type PlatformSignals } from '../../src/platform.js';

const top = (s: PlatformSignals) => decidePlatform({ site: 'https://e.org/', ...s })?.id ?? 'unknown';

describe('Astro', () => {
  it('from the generator tag Astro writes', () => {
    expect(top({ generator: ['Astro v5.1.3'] })).toBe('astro');
    expect(top({ generator: ['Astro v4.16.0'] })).toBe('astro');
  });
  it('from the data-astro-cid-* marker the collector reports', () => {
    expect(top({ markers: ['astro'] })).toBe('astro');
  });
  it('from two build files under /_astro/ on the site itself, never on another host', () => {
    expect(top({ assets: ['https://e.org/_astro/index.B2x1.css', 'https://e.org/_astro/client.Cx9.js'] })).toBe('astro');
    expect(top({ assets: ['https://cdn.example/_astro/a.css', 'https://cdn.example/_astro/b.js'] })).toBe('unknown');
  });
  it('a page that only mentions Astro is not Astro', () => {
    expect(top({ generator: ['Built with care, not Astro'] })).toBe('unknown');
  });
  it('named in plain words, with no editor guidance (it is a site builder for developers, not a CMS)', () => {
    const p = PLATFORMS.find((x) => x.id === 'astro')!;
    expect(p.name).toBe('Astro');
    expect(p.sign).toMatch(/data-astro-cid|_astro/);
    expect(platformGuidance('astro', 'alt')).toBeNull();
  });
});
