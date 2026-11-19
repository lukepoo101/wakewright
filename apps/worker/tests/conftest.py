"""Fixtures shared by the cloud judge tests."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fakes import FakeService


@pytest.fixture
def service() -> Iterator[FakeService]:
    """A local fake HTTP service; nothing reaches the network."""
    s = FakeService().start()
    yield s
    s.stop()
