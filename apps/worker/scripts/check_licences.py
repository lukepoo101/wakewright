"""Fail when an installed Python distribution's licence is not on the allow list.

The Python side of scripts/check-licences.ts, with the same policy: the
worker image ships these packages, so each must carry a licence that lets
an Apache-2.0 project redistribute it unchanged. Anything else fails, and
the fix is a decision: replace the package, or add the licence here with a
reason in the same pull request.

It reads the metadata of every distribution installed in the running
environment (`uv run` uses apps/worker/.venv: runtime and dev packages), so
it runs offline. The licence is the `License-Expression` field (SPDX) if
present, else the `License` field, else the `License ::` classifiers, read
through ALIASES for the free-text spellings packages use.

Usage: uv run python scripts/check_licences.py   Exit 0 when all pass, 1 otherwise.
"""

from __future__ import annotations

import re
import sys
from importlib.metadata import Distribution, distributions

# The allow list of scripts/check-licences.ts ...
ALLOWED = {
    "0BSD",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "CC0-1.0",
    "ISC",
    "MIT",
    "Unlicense",
    # ... plus licences Python packages use:
    # Python's own licence (typing_extensions): permissive.
    "PSF-2.0",
    # zlib licence (part of numpy): permissive.
    "Zlib",
    # certifi (httpx's CA bundle), shipped unmodified. MPL-2.0 is file-level
    # copyleft: it binds changes to certifi's own files only, never ours.
    "MPL-2.0",
}

# Free-text `License` values and classifiers, as packages write them.
ALIASES = {
    "apache": "Apache-2.0",
    "apache 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "bsd": "BSD-3-Clause",
    "bsd license": "BSD-3-Clause",
    "3-clause bsd license": "BSD-3-Clause",
    "mit license": "MIT",
    "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "python software foundation license": "PSF-2.0",
}


def allowed(expression: str) -> bool:
    """SPDX check without a parser: passes when one OR branch has only
    allowed licences (parentheses flattened, as in check-licences.ts)."""
    flat = re.sub(r"[()]", " ", expression).strip()
    if not flat:
        return False
    return any(
        all(part.strip() in ALLOWED for part in re.split(r"\s+AND\s+", branch))
        for branch in re.split(r"\s+OR\s+", flat)
    )


def licence_of(dist: Distribution) -> str:
    meta = dist.metadata
    expression = meta.get("License-Expression")
    if expression:
        return expression
    raw = (meta.get("License") or "").strip()
    if raw and "\n" not in raw and len(raw) < 80:
        return _alias(raw)
    classifiers = [
        c.split(" :: ")[-1]
        for c in meta.get_all("Classifier") or []
        if c.startswith("License :: ") and c != "License :: OSI Approved"
    ]
    return " OR ".join(_alias(c) for c in classifiers)


def _alias(value: str) -> str:
    return ALIASES.get(value.lower()) or value


def main() -> int:
    failures: list[str] = []
    checked = 0
    for dist in sorted(distributions(), key=lambda d: d.metadata["Name"].lower()):
        name = dist.metadata["Name"]
        if name == "wakewright-worker":
            continue
        checked += 1
        licence = licence_of(dist)
        if not allowed(licence):
            failures.append(f"{name} {dist.version}: {licence or 'no licence metadata'}")
    if failures:
        for f in failures:
            print(f"check_licences: not allowed: {f}", file=sys.stderr)
        print("check_licences: see apps/worker/scripts/check_licences.py", file=sys.stderr)
        return 1
    print(f"check_licences: {checked} Python packages, all under allowed licences")
    return 0


if __name__ == "__main__":
    sys.exit(main())
