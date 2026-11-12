import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAgent } from '../../src/runtimes/detection.js';
import { deepseekHarnessAgentDef } from '../../src/runtimes/defs/deepseek-harness.js';

// The shipped def carries a compatibilityProbe: a passing probe is the daemon
// having verified the exact generation-1 profile handshake (frames.ts asserts
// v/type/runtime/protocol_version/capabilities), so the version number is
// informational. A dsh release outside `supportedVersionPattern` must stay
// available with no `untested-version` diagnostic as long as the probe passes.
// The probe-less path (version line warns) stays covered by
// tests/runtimes/version-policy.test.ts, which strips the probe from the same
// def — these suites hold the two shapes apart.

const PROBE_FRAME = JSON.stringify({
  v: 1,
  type: 'probe',
  runtime: 'open-design',
  protocol_version: 1,
  plugin_version: '0.1.0',
  capabilities: {
    session_resume: true,
    session_cancel: true,
    structured_events: true,
  },
});

function writeProfileBin(dir: string, version: string): string {
  const bin = path.join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  if (process.platform === 'win32') {
    writeFileSync(
      bin,
      `@echo off\r\nif "%1"=="--version" (echo ${version}) else (echo ${PROBE_FRAME})\r\n`,
    );
  } else {
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; else printf '%s\\n' '${PROBE_FRAME}'; fi\n`,
    );
    chmodSync(bin, 0o755);
  }
  return bin;
}

// The shipped probe preflight requires an installed open-design profile; point
// DSH_HOME at the fixture and materialize it.
function writeProfileHome(dir: string): string {
  const profileDir = path.join(dir, 'profiles', 'open-design');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'open-design', plugin_version: '0.1.0' }),
  );
  return dir;
}

async function detectWithProfileStub(version: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-dsh-protocol-first-'));
  try {
    const dshHome = writeProfileHome(dir);
    return await detectAgent(deepseekHarnessAgentDef, {
      DSH_BIN: writeProfileBin(dir, version),
      DSH_HOME: dshHome,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('dsh-profile protocol-first detection', () => {
  it.each([
    ['9.9.9', 'a stable release off the accepted line'],
    ['0.2.0-rc.1', 'a newer release candidate line'],
    ['0.1.3-rc.2', 'a release candidate line the pattern does not know'],
  ] as const)('keeps %s available (%s) when the probe passes', async (version, _label) => {
    const detected = await detectWithProfileStub(version);
    expect(detected.available).toBe(true);
    expect(detected.version).toBe(version);
    const untested = detected.diagnostics?.filter(
      (diagnostic) => diagnostic.reason === 'untested-version',
    );
    expect(untested ?? []).toEqual([]);
  });

  it('keeps an on-line version available without a warning when the probe passes', async () => {
    const detected = await detectWithProfileStub('0.1.1-rc.2');
    expect(detected.available).toBe(true);
    expect(detected.version).toBe('0.1.1-rc.2');
    const untested = detected.diagnostics?.filter(
      (diagnostic) => diagnostic.reason === 'untested-version',
    );
    expect(untested ?? []).toEqual([]);
  });
});
