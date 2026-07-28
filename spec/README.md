# `openapi.snapshot.json` — a snapshot, never an authority

This file is vendored from the Python SDK (`elliottech/lighter-python`, repository root
`openapi.json`). It is the only machine-readable description of the REST API that exists.

```
sha256  3a53c619ef3eb537217c889d1d6bd322015548a31c045538eb547c7195c9953f
openapi 3.0.0     78 paths     142 schemas
```

## Why it is not the source of truth

**It is unversioned.** Its own `info` block is literally `{"title": "", "version": ""}`. There is no
way to tell which deployment of the API it describes, or whether it has drifted.

**There is no live endpoint to refresh it from.** Every plausible path is blocked:

| URL | Result |
| --- | --- |
| `/api/v1/swagger/doc.json` | 403, empty body |
| `/swagger/doc.json` | 403, empty body |
| `/openapi.json` | 403 |
| `/swagger.json` | 403 |

Same `User-Agent` that returns 200 on `/orderBooks`, so this is a deliberate block rather than bot
detection. "Regenerate types from the live spec at build time" is not an available strategy, and any
proposal that assumes it is has not been tested.

**It is demonstrably wrong in places.** The live API returns shapes this document does not describe.
The clearest example: `/withdrawalDelay` returns `{"seconds": 1542}` with no `code` field at all,
while the document models every response as carrying the standard envelope. A generated client that
trusted it would classify a successful response as malformed.

## How it is actually used

- **Core trading models are hand-authored** from captured live responses
  (`test/fixtures/rest/`), using this file only as a cross-reference for field names and
  nullability. Where the two disagree, the captured response wins.
- **The long tail is not generated into types at all** for v1 (`docs/decisions.md` D10). Those
  endpoints are reachable through the typed route table with raw response access.
- Treat every field here as **optional** unless a captured fixture proves otherwise.

## Updating it

Re-copy from a newer `lighter-python` checkout, update the digest above, and diff before accepting.
Because the file carries no version, the diff is the only signal that anything changed.
