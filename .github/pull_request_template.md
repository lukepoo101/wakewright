<!--
Title: a plain-English, imperative summary of the outcome, for example
"Show the clip's score on the clip page". It becomes the commit and the
changelog entry. The maintainer adds a label (bug, enhancement, breaking,
documentation...) that picks the changelog section.
-->

## Change

What problem this solves and how it behaves now.

## Validation

What you ran (`mise run check`, `mise run e2e`, manual steps) and what you
did not verify.

## Checklist

- [ ] `mise run check` passes; tests cover the change
- [ ] Docs and ADRs describe the system as it now is
- [ ] Any new dependency is justified above (why, licence, maintenance)
- [ ] No real audio, credentials, or Kiosk Satellite or other third-party assets added
- [ ] Device access stays read only
