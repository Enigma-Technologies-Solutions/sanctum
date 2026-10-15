// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// registry/apps/<app_id>/CHANGELOG.md is written for people and parsed strictly:
//
//   # Changelog                       (optional title)
//
//   ## 1.0.2 (2026-10-02)
//   - added: Something new.
//   - fixed: Something that was wrong.
//
// Types: added, changed, fixed, security, removed. Newest first.

const TYPES = ['added', 'changed', 'fixed', 'security', 'removed'];

export function parseChangelog(src) {
  const entries = [];
  let current = null;
  src.split('\n').forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.trimEnd();
    if (line === '' || /^#\s+\S/.test(line)) return;
    const head = /^##\s+(\d+(?:\.\d+){0,3})\s+\((\d{4}-\d{2}-\d{2})\)$/.exec(line);
    if (head) {
      if (current && current.changes.length === 0) throw new Error(`CHANGELOG line ${n}: ${current.version} has no changes`);
      const date = new Date(`${head[2]}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== head[2]) {
        throw new Error(`CHANGELOG line ${n}: ${head[2]} is not a real date`);
      }
      if (entries.some((e) => e.version === head[1])) throw new Error(`CHANGELOG line ${n}: duplicate version ${head[1]}`);
      current = { version: head[1], date: head[2], changes: [] };
      entries.push(current);
      return;
    }
    const item = /^-\s+([a-z]+):\s+(\S.*)$/.exec(line);
    if (item && current) {
      if (!TYPES.includes(item[1])) throw new Error(`CHANGELOG line ${n}: type must be one of ${TYPES.join(', ')}`);
      if ([...item[2]].length > 300) throw new Error(`CHANGELOG line ${n}: entry is over 300 characters`);
      current.changes.push({ type: item[1], text: item[2] });
      return;
    }
    throw new Error(`CHANGELOG line ${n}: expected "## X.Y.Z (YYYY-MM-DD)" or "- type: text", got "${line}"`);
  });
  if (current && current.changes.length === 0) throw new Error(`CHANGELOG: ${current.version} has no changes`);
  if (entries.length === 0) throw new Error('CHANGELOG has no versions');
  return entries;
}
