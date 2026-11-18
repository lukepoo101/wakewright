"""Verify uv.lock against the release-age policy in pyproject.toml.

The Python side of scripts/verify-lockfile-age.ts. `[tool.uv] exclude-newer`
("3 days") makes uv refuse young distributions when it resolves, but a
lockfile edited by hand or by another tool would be trusted as written by
`uv sync --frozen`. uv.lock records each file's `upload-time`, so this
check runs offline: every sdist and wheel of every locked package must have
been uploaded at least the policy's age before now.

Usage: python scripts/check_lock_age.py   Exit 0 when the lock passes, 1 on a
violation, 2 when it cannot check (missing policy or file).
"""

from __future__ import annotations

import re
import sys
import tomllib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
UNITS = {"day": 86400, "days": 86400, "hour": 3600, "hours": 3600, "week": 604800, "weeks": 604800}


def policy_seconds(pyproject: dict[str, Any]) -> int:
    raw = pyproject.get("tool", {}).get("uv", {}).get("exclude-newer")
    m = re.fullmatch(r"\s*(\d+)\s+(\w+)\s*", str(raw or ""))
    if not m or m.group(2) not in UNITS:
        raise ValueError(
            f'[tool.uv] exclude-newer must be a duration such as "3 days", got {raw!r}'
        )
    return int(m.group(1)) * UNITS[m.group(2)]


def main() -> int:
    try:
        pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        min_age = policy_seconds(pyproject)
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"check_lock_age: cannot check: {e}", file=sys.stderr)
        return 2
    now = datetime.now(UTC)
    failures: list[str] = []
    checked = 0
    youngest: tuple[timedelta, str] | None = None
    for package in lock.get("package", []):
        source = package.get("source", {})
        if "registry" not in source:
            continue  # the project itself (editable/virtual)
        files = [package["sdist"]] if "sdist" in package else []
        files += package.get("wheels", [])
        spec = f"{package['name']}=={package['version']}"
        if not files:
            failures.append(f"{spec}: no files in uv.lock to date")
            continue
        checked += 1
        for f in files:
            uploaded = f.get("upload-time")
            if not uploaded:
                failures.append(f"{spec}: {f.get('url', '?')} has no upload-time")
                continue
            age = now - datetime.fromisoformat(uploaded)
            if youngest is None or age < youngest[0]:
                youngest = (age, spec)
            if age.total_seconds() < min_age:
                failures.append(f"{spec}: {f['url'].rsplit('/', 1)[-1]} uploaded {uploaded}")
    if failures:
        print(
            f"uv.lock violates the release-age policy ({min_age // 86400} days):", file=sys.stderr
        )
        for f in sorted(set(failures)):
            print(f"  {f}", file=sys.stderr)
        return 1
    young = f"; youngest is {youngest[1]}, {youngest[0].days} days old" if youngest else ""
    print(f"uv.lock: {checked} packages pass the {min_age // 86400}-day release age{young}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
