'use strict';

/**
 * The public status artifact is built, not filtered (#239): these tests
 * hold the builder to the closed vocabulary, the deterministic mapping,
 * the bounded history, and — most importantly — the property that no
 * observation, health-response, or previously-published value can reach
 * the public output as anything but one of four words.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCHEMA,
  STATUSES,
  COMPONENTS,
  HISTORY_LIMIT,
  componentStatuses,
  overallOf,
  buildArtifact,
  assertPublishable,
  main,
} = require('./status-artifact.js');

const NOW = '2026-08-08T12:00:00.000Z';
const HEALTHY = { healthz: '200', readyz: '200', frontend: '200', capability: 'healthy' };

test('all components healthy -> operational everywhere', () => {
  const artifact = buildArtifact({ observation: HEALTHY, now: NOW });
  assert.equal(artifact.overall, 'operational');
  assert.deepEqual(artifact.components, {
    api: 'operational', webApplication: 'operational', coreCapabilities: 'operational',
  });
  assert.equal(artifact.history.length, 1);
  assert.equal(artifact.history[0].at, NOW);
});

test('API unreachable (timeout/curl failure records 000) -> unavailable', () => {
  const artifact = buildArtifact({
    observation: { ...HEALTHY, healthz: '000', readyz: '000', capability: 'unreachable' },
    now: NOW,
  });
  assert.equal(artifact.components.api, 'unavailable');
  assert.equal(artifact.components.coreCapabilities, 'unknown');
  assert.equal(artifact.overall, 'unavailable');
});

test('API reachable but readiness impaired -> degraded', () => {
  for (const readyz of ['503', '000', '500', 'garbage']) {
    const artifact = buildArtifact({ observation: { ...HEALTHY, readyz }, now: NOW });
    assert.equal(artifact.components.api, 'degraded', `readyz=${readyz}`);
    assert.equal(artifact.overall, 'degraded');
  }
});

test('frontend unavailable -> unavailable, other components unaffected', () => {
  const artifact = buildArtifact({ observation: { ...HEALTHY, frontend: '000' }, now: NOW });
  assert.equal(artifact.components.webApplication, 'unavailable');
  assert.equal(artifact.components.api, 'operational');
  assert.equal(artifact.overall, 'unavailable');
});

test('capability rollup words map deterministically; anything else is unknown', () => {
  const cases = {
    healthy: 'operational',
    degraded: 'degraded',
    unavailable: 'unavailable',
    'not-active': 'unknown',
    unreachable: 'unknown',
    // Malformed health responses must degrade to a safe word, never
    // pass through: unrecognized rollups, empty, objects, injections.
    HEALTHY: 'unknown',
    '': 'unknown',
    'internal-hostname db-7.hidden.invalid': 'unknown',
  };
  for (const [rollup, expected] of Object.entries(cases)) {
    const { coreCapabilities } = componentStatuses({ ...HEALTHY, capability: rollup });
    assert.equal(coreCapabilities, expected, `rollup=${JSON.stringify(rollup)}`);
  }
  assert.equal(componentStatuses({ ...HEALTHY, capability: { status: 'healthy' } }).coreCapabilities, 'unknown');
});

test('a missing or malformed observation fails closed, not open', () => {
  for (const observation of [null, undefined, 'not json', 42, []]) {
    const artifact = buildArtifact({ observation, now: NOW });
    assert.equal(artifact.components.api, 'unavailable');
    assert.equal(artifact.components.webApplication, 'unavailable');
    assert.equal(artifact.components.coreCapabilities, 'unknown');
  }
});

test('overall is worst-of; all-unknown stays unknown rather than pretending', () => {
  assert.equal(overallOf({ api: 'operational', webApplication: 'degraded', coreCapabilities: 'unavailable' }), 'unavailable');
  assert.equal(overallOf({ api: 'operational', webApplication: 'operational', coreCapabilities: 'degraded' }), 'degraded');
  assert.equal(overallOf({ api: 'unknown', webApplication: 'unknown', coreCapabilities: 'unknown' }), 'unknown');
  // A dark capability leg must not drag a healthy service below operational.
  assert.equal(overallOf({ api: 'operational', webApplication: 'operational', coreCapabilities: 'unknown' }), 'operational');
});

test('unexpected internal fields in the observation never reach the output', () => {
  const artifact = buildArtifact({
    observation: {
      ...HEALTHY,
      // The kinds of things a compromised or buggy probe could try to
      // smuggle: none may survive serialization.
      hostname: 'db-7.hidden.invalid',
      GUIDEHERD_MONITOR_CREDENTIAL: 'hunter2-not-a-real-secret',
      stack: 'Error: boom\n  at /app/server/handoff/app.js:1',
      capabilityDetail: [{ capability: 'operational-store', status: 'unavailable' }],
    },
    now: NOW,
  });
  const serialized = JSON.stringify(artifact);
  for (const fragment of ['hidden.invalid', 'hunter2', 'MONITOR_CREDENTIAL', 'app.js', 'operational-store', 'stack', 'Error']) {
    assert.equal(serialized.includes(fragment), false, `leaked ${fragment}`);
  }
  // The output is made ONLY of schema keys, component keys, the four
  // statuses, and normalized timestamps.
  const words = serialized.match(/"[^"]+"/g).map((w) => w.slice(1, -1));
  const allowed = new Set([
    'schema', SCHEMA, 'generatedAt', 'staleAfterMinutes', 'overall', 'components', 'history', 'at',
    ...COMPONENTS, ...STATUSES,
  ]);
  for (const word of words) {
    assert.ok(allowed.has(word) || !Number.isNaN(Date.parse(word)), `unexpected published value ${JSON.stringify(word)}`);
  }
});

test('history is appended, ordered, and bounded', () => {
  let previous = null;
  for (let i = 0; i < HISTORY_LIMIT + 25; i += 1) {
    const at = new Date(Date.parse('2026-08-01T00:00:00.000Z') + i * 900_000).toISOString();
    previous = buildArtifact({ observation: HEALTHY, previous, now: at });
  }
  assert.equal(previous.history.length, HISTORY_LIMIT);
  assert.equal(previous.history.at(-1).at, previous.generatedAt);
  const first = Date.parse(previous.history[0].at);
  const last = Date.parse(previous.history.at(-1).at);
  assert.ok(first < last, 'oldest entries were the ones dropped');
});

test('a poisoned previously-published artifact cannot inject history', () => {
  const artifact = buildArtifact({
    observation: HEALTHY,
    previous: {
      schema: SCHEMA,
      history: [
        { at: '2026-08-08T11:00:00.000Z', api: 'operational', webApplication: 'operational', coreCapabilities: 'unknown', overall: 'operational' },
        { at: '2026-08-08T11:15:00.000Z', api: 'db-7.hidden.invalid is down', webApplication: 'operational', coreCapabilities: 'unknown', overall: 'operational' },
        { at: '<script>alert(1)</script>', api: 'operational', webApplication: 'operational', coreCapabilities: 'unknown', overall: 'operational' },
        { at: '2026-08-08T11:30:00.000Z', api: 'operational', webApplication: 'operational', coreCapabilities: 'unknown', overall: 'operational', note: 'tenant 4711 offline' },
        'garbage',
      ],
    },
    now: NOW,
  });
  // Only the two clean entries survive, plus the fresh observation.
  assert.equal(artifact.history.length, 3);
  const serialized = JSON.stringify(artifact);
  for (const fragment of ['hidden.invalid', 'script', 'tenant', 'garbage', 'note']) {
    assert.equal(serialized.includes(fragment), false, `leaked ${fragment}`);
  }
});

test('a previous artifact that is not an artifact at all starts history fresh', () => {
  for (const previous of [null, 'garbage', 42, [], { history: 'nope' }]) {
    const artifact = buildArtifact({ observation: HEALTHY, previous, now: NOW });
    assert.equal(artifact.history.length, 1);
  }
});

test('drill artifacts are labeled and carry no real history', () => {
  const real = buildArtifact({ observation: HEALTHY, now: '2026-08-08T11:00:00.000Z' });
  const drill = buildArtifact({
    observation: { healthz: '000', readyz: '000', frontend: '200', capability: 'unreachable' },
    previous: real,
    now: NOW,
    drill: true,
  });
  assert.equal(drill.drill, true);
  assert.equal(drill.overall, 'unavailable');
  assert.equal(drill.components.api, 'unavailable');
  assert.deepEqual(drill.history.map((entry) => entry.at), [NOW],
    'a simulated outage must not write itself into real history');
  assert.equal('drill' in real, false, 'real artifacts carry no drill key');
});

test('the artifact schema gate rejects anything off-contract', () => {
  const good = buildArtifact({ observation: HEALTHY, now: NOW });
  assertPublishable(good);
  const broken = [
    { ...good, extra: 'field' },
    { ...good, overall: 'down' },
    { ...good, schema: 'guideherd-public-status/0' },
    { ...good, components: { ...good.components, api: 'ok' } },
    { ...good, components: { ...good.components, extrahost: 'operational' } },
    { ...good, history: [{ ...good.history[0], hostname: 'internal' }] },
    { ...good, history: new Array(HISTORY_LIMIT + 1).fill(good.history[0]) },
    { ...good, generatedAt: 'yesterday' },
    { ...good, drill: 'yes' },
  ];
  for (const artifact of broken) {
    assert.throws(() => assertPublishable(artifact), /unpublishable/, JSON.stringify(Object.keys(artifact)));
  }
});

test('an invalid observation instant is fatal (nothing gets published)', () => {
  for (const now of [undefined, '', 'today', '2026-13-45T99:99:99Z x']) {
    assert.throws(() => buildArtifact({ observation: HEALTHY, now }));
  }
});

test('CLI round-trip: observation file in, validated artifact file out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-artifact-'));
  try {
    const observationPath = path.join(dir, 'obs.json');
    const previousPath = path.join(dir, 'prev.json');
    const outPath = path.join(dir, 'status.json');
    fs.writeFileSync(observationPath, JSON.stringify({ ...HEALTHY, readyz: '503' }));
    fs.writeFileSync(previousPath, JSON.stringify(buildArtifact({ observation: HEALTHY, now: '2026-08-08T11:00:00.000Z' })));
    main(['--observation', observationPath, '--previous', previousPath, '--out', outPath, '--now', NOW], fs);
    const artifact = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assertPublishable(artifact);
    assert.equal(artifact.components.api, 'degraded');
    assert.equal(artifact.history.length, 2);

    // A missing previous artifact is a fresh start, not a failure.
    main(['--observation', observationPath, '--previous', path.join(dir, 'absent.json'), '--out', outPath, '--now', NOW], fs);
    assert.equal(JSON.parse(fs.readFileSync(outPath, 'utf8')).history.length, 1);

    // Drill flag propagates.
    main(['--observation', observationPath, '--out', outPath, '--now', NOW, '--drill'], fs);
    assert.equal(JSON.parse(fs.readFileSync(outPath, 'utf8')).drill, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
