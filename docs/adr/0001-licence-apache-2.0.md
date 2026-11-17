# 0001 Licence: Apache-2.0

- Status: accepted
- Date: 2026-11-17

## Context

Wakewright is open source and meant to sit beside Home Assistant and the
wake word engines it trains for (openWakeWord and microWakeWord code are
Apache-2.0). Many useful models and datasets in this field are licensed for
non-commercial use only.

## Decision

All code in the repository is licensed under Apache-2.0: it has an explicit
patent grant and makes contributions inbound = outbound (section 5), so no
CLA is needed. MIT was the runner-up (no patent grant).

No third-party model weights, non-commercially licensed datasets, Kiosk
Satellite or vsWakeWord files, or household audio are ever committed or put
in an image. Test audio is generated in code.

## Consequences

Third-party assets a later worker needs are downloaded at runtime, pinned by
checksum, after the user accepts each licence. Trained models can carry a
more restrictive licence than the code; the registry will record it.
