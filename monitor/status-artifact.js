'use strict';

/**
 * Public status artifact builder (GitLab #239).
 *
 * Converts one external-monitor observation into the sanitized JSON the
 * public status page renders. This is the ONLY code that decides what
 * the public may see, and it works by construction, not by filtering:
 * every value in the output is produced from a closed lookup table or a
 * validated timestamp — nothing from an observation, a health response,
 * or a previously published artifact is ever copied through. A probe
 * answer of "secret-hostname-500" and a probe answer of "503" publish
 * the same word.
 *
 * Inputs are treated as untrusted, INCLUDING the previously published
 * artifact (the status-data branch is not a trusted store; it is
 * whatever was last pushed). Anything malformed degrades to 'unknown'
 * or is dropped — never passed through, never fatal to the page.
 *
 * The observation cadence is the #23 monitor's existing schedule
 * (GitLab #241 accepted 60-90 minutes observed); this builder adds no
 * polling of its own.
 */

const SCHEMA = 'guideherd-public-status/1';

// The complete public vocabulary. The page maps these four words to
// display text; nothing else ever appears in a published artifact.
const STATUSES = Object.freeze(['operational', 'degraded', 'unavailable', 'unknown']);

// The complete public component set, in display order. Display names
// live in the page; these keys are the contract between builder and page.
const COMPONENTS = Object.freeze(['api', 'webApplication', 'coreCapabilities']);

// After this long without a fresh observation the page must stop
// claiming anything: ~3x the worst observed monitor cadence (#241).
const STALE_AFTER_MINUTES = 240;

// Bounded history: at the requested 15-minute cadence this is 3.5 days;
// at the observed 60-90-minute cadence, roughly two weeks. Either way it
// is a fixed byte budget, not a log.
const HISTORY_LIMIT = 336;

// Capability rollup words the monitor may report, mapped to the public
// vocabulary. 'not-active' is the credential-less monitor leg;
// 'unreachable' means the leg could not be read at all (the API
// component already says what happened). Absent entries fall to
// 'unknown' — fail closed, never pass through.
const CAPABILITY_ROLLUP = Object.freeze({
  healthy: 'operational',
  degraded: 'degraded',
  unavailable: 'unavailable',
  'not-active': 'unknown',
  unreachable: 'unknown',
});

function isHttpOk(value) {
  return value === '200';
}

/**
 * Deterministic mapping from one raw observation to public component
 * statuses (the ticket's mapping, verbatim):
 *   - liveness AND readiness answer 200        -> operational
 *   - liveness 200, readiness anything else    -> degraded
 *   - liveness not 200 (incl. timeout/garbage) -> unavailable
 *   - frontend 200 -> operational, else unavailable
 *   - capability rollup through CAPABILITY_ROLLUP, else unknown
 */
function componentStatuses(observation) {
  const obs = observation && typeof observation === 'object' ? observation : {};
  const api = !isHttpOk(obs.healthz) ? 'unavailable'
    : isHttpOk(obs.readyz) ? 'operational'
    : 'degraded';
  const webApplication = isHttpOk(obs.frontend) ? 'operational' : 'unavailable';
  const coreCapabilities =
    (typeof obs.capability === 'string' && CAPABILITY_ROLLUP[obs.capability]) || 'unknown';
  return { api, webApplication, coreCapabilities };
}

/** Worst-of rollup; all-unknown stays unknown rather than pretending. */
function overallOf(components) {
  const values = COMPONENTS.map((key) => components[key]);
  if (values.includes('unavailable')) return 'unavailable';
  if (values.includes('degraded')) return 'degraded';
  if (values.every((value) => value === 'unknown')) return 'unknown';
  return 'operational';
}

/** A strict ISO-8601 UTC instant, re-serialized so no crafted string survives. */
function normalizeInstant(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * One history entry rebuilt field by field from the closed vocabularies.
 * Anything unexpected — extra keys, non-enum values, bad timestamps —
 * makes the entry invalid and it is dropped, not repaired.
 */
function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const at = normalizeInstant(entry.at);
  if (!at) return null;
  const rebuilt = { at };
  for (const key of COMPONENTS) {
    if (!STATUSES.includes(entry[key])) return null;
    rebuilt[key] = entry[key];
  }
  if (!STATUSES.includes(entry.overall)) return null;
  rebuilt.overall = entry.overall;
  return rebuilt;
}

/** The previous artifact's history, kept only where every entry re-validates. */
function normalizePreviousHistory(previous) {
  if (!previous || typeof previous !== 'object' || !Array.isArray(previous.history)) return [];
  const entries = [];
  for (const entry of previous.history.slice(-HISTORY_LIMIT)) {
    const normalized = normalizeHistoryEntry(entry);
    if (normalized) entries.push(normalized);
  }
  return entries;
}

/**
 * Build the artifact. `now` is a required ISO instant (the workflow
 * passes wall-clock; tests pass fixtures). `previous` is the last
 * published artifact or null. `drill` marks a simulated observation so
 * the page can label it and it carries no real history.
 */
function buildArtifact({ observation, previous = null, now, drill = false }) {
  const at = normalizeInstant(now);
  if (!at) throw new Error('a valid observation instant is required');
  const components = componentStatuses(observation);
  const overall = overallOf(components);
  const entry = { at, ...components, overall };
  const history = drill ? [entry] : [...normalizePreviousHistory(previous), entry].slice(-HISTORY_LIMIT);
  const artifact = {
    schema: SCHEMA,
    generatedAt: at,
    staleAfterMinutes: STALE_AFTER_MINUTES,
    overall,
    components,
    history,
    ...(drill ? { drill: true } : {}),
  };
  assertPublishable(artifact);
  return artifact;
}

/**
 * The last line of defense before anything is written: the artifact must
 * match the public schema EXACTLY — allowlisted keys, enum values,
 * normalized timestamps, bounded history — or nothing is published and
 * the page goes stale into 'unknown' instead.
 */
function assertPublishable(artifact) {
  const fail = (reason) => { throw new Error(`unpublishable artifact: ${reason}`); };
  if (!artifact || typeof artifact !== 'object') fail('not an object');
  const allowedKeys = ['schema', 'generatedAt', 'staleAfterMinutes', 'overall', 'components', 'history', 'drill'];
  for (const key of Object.keys(artifact)) {
    if (!allowedKeys.includes(key)) fail(`unexpected key ${JSON.stringify(key)}`);
  }
  if (artifact.schema !== SCHEMA) fail('wrong schema');
  if (normalizeInstant(artifact.generatedAt) !== artifact.generatedAt) fail('generatedAt');
  if (artifact.staleAfterMinutes !== STALE_AFTER_MINUTES) fail('staleAfterMinutes');
  if (!STATUSES.includes(artifact.overall)) fail('overall');
  if ('drill' in artifact && artifact.drill !== true) fail('drill');
  const components = artifact.components;
  if (!components || typeof components !== 'object') fail('components');
  const componentKeys = Object.keys(components);
  if (componentKeys.length !== COMPONENTS.length) fail('component set');
  for (const key of COMPONENTS) {
    if (!STATUSES.includes(components[key])) fail(`component ${key}`);
  }
  if (!Array.isArray(artifact.history)) fail('history');
  if (artifact.history.length > HISTORY_LIMIT) fail('history length');
  for (const entry of artifact.history) {
    const normalized = normalizeHistoryEntry(entry);
    if (!normalized) fail('history entry');
    if (Object.keys(entry).length !== Object.keys(normalized).length) fail('history entry keys');
  }
}

/** Read a JSON file as an untrusted value: absent or malformed is null, never fatal. */
function readUntrustedJson(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function main(argv, fs) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const flag = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.set(flag, argv[i + 1]);
        i += 1;
      } else {
        args.set(flag, true);
      }
    }
  }
  const observationPath = args.get('observation');
  const outPath = args.get('out');
  const now = args.get('now');
  if (typeof observationPath !== 'string' || typeof outPath !== 'string' || typeof now !== 'string') {
    throw new Error('usage: status-artifact --observation <file> --out <file> --now <iso> [--previous <file>] [--drill]');
  }
  const previousPath = args.get('previous');
  const artifact = buildArtifact({
    observation: readUntrustedJson(fs, observationPath),
    previous: typeof previousPath === 'string' ? readUntrustedJson(fs, previousPath) : null,
    now,
    drill: args.get('drill') === true,
  });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 1)}\n`);
}

module.exports = {
  SCHEMA,
  STATUSES,
  COMPONENTS,
  STALE_AFTER_MINUTES,
  HISTORY_LIMIT,
  componentStatuses,
  overallOf,
  buildArtifact,
  assertPublishable,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2), require('node:fs'));
}
