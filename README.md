# guideherd-status

The sanitized public GuideHerd status artifact, and the minimal machinery
that produces it. Public and self-contained: it holds no credentials, no
infrastructure identifiers, no tenant/customer data, no raw monitoring
payloads.

## What the public sees

The live artifact is published to the **`status-data`** branch as
`status.json` (and `status-drill.json` for the simulated-outage drill),
and retrieved by the public status page over
`https://raw.githubusercontent.com/uasdj25/guideherd-status/refs/heads/status-data/status.json`.

## Schema (`guideherd-public-status/1`)

A closed vocabulary — three components, four coarse states, bounded
history, nothing else:

```json
{
  "schema": "guideherd-public-status/1",
  "generatedAt": "<ISO-8601>",
  "staleAfterMinutes": 240,
  "overall": "operational | degraded | unavailable | unknown",
  "components": {
    "api": "...", "webApplication": "...", "coreCapabilities": "..."
  },
  "history": [ { "at": "<ISO-8601>", "api": "...", "webApplication": "...", "coreCapabilities": "...", "overall": "..." } ]
}
```

## Machinery

`monitor/status-artifact.js` builds the artifact by construction from
closed lookup tables — no observed value is ever copied through — covered
by a dependency-free `node --test` suite.
The external monitor (run outside any GuideHerd platform) feeds raw
observations to these builders and force-pushes the result to the
`status-data` branch; the machinery here is what makes the output
sanitized by construction rather than by filtering.
