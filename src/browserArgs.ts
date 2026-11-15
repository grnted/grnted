// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Chromium launch arguments for local scans (CLI). Engine core: plain data, no imports.

/**
 * `--mute-audio`: no tab ever plays sound, whatever a page or an embedded player does. The
 * media-players probe also keeps every media element muted and Web Audio suspended inside the page.
 */
export const BROWSER_ARGS: readonly string[] = ['--mute-audio'];
