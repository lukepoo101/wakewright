# Contributing to Wakewright

Thank you for your interest. Wakewright is pre-alpha and maintained by one
person, so please open an issue to discuss anything larger than a small fix
before you write code.

Scope: improving wake word detection for self-hosted voice satellites. Out
of scope: general speech-to-text or text-to-speech, cloud services,
telemetry and hosted offerings.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

Install [mise](https://mise.jdx.dev), then:

```sh
mise install       # the Bun version pinned in mise.toml
mise run setup     # install dependencies from bun.lock
mise run dev       # parent with hot reload + two fake Kiosk Satellite devices
```

Install the pre-push hook once, so `mise run check` runs before every push:

```sh
mise generate git-pre-commit --write --hook pre-push --task check
```

Never bypass it (`--no-verify`); fix what it reports.

## Checks

`mise run check` runs everything CI checks except the image build:
tool-version drift, the lockfile release-age policy, `bun fmt --check`,
Biome lint, `bun check` (types) and `bun test`. `mise run e2e` runs the
Playwright smoke test against the production build. Run `bun fmt` to fix
formatting. See [docs/development.md](docs/development.md) for what each
step does and how CI runs them.

## Pull requests

CI runs every check on your pull request, from a fork too, in about a
minute; the `CI OK` check must pass. Questions go to
[Discussions](https://github.com/lukepoo101/wakewright/discussions).

- Keep each pull request to one change, with tests at the lowest level that
  proves it.
- Write the title as a plain-English, imperative summary of the outcome,
  for example "Show the clip's score on the clip page". Pull requests are
  squash-merged, so the title becomes the commit and the changelog entry
  ([docs/RELEASING.md](docs/RELEASING.md)). There is nothing else to write
  for the changelog.
- Fill in the pull request template.
- Justify any new dependency in the description (why, licence, maintenance).
  `bun add` pins exact versions, and releases younger than three days are
  refused (`bunfig.toml`).
- Record a changed architectural decision as a new ADR in `docs/adr/`.

## What we cannot accept

- Real household audio, recordings of people, device passwords or tokens.
  Test audio is generated in code.
- Any code, documentation text, assets or models from Kiosk Satellite or
  vsWakeWord, and any non-commercially licensed model or dataset.
- Code that writes to a device.

Contributions are licensed under [Apache-2.0](LICENSE) (section 5: inbound
= outbound).
