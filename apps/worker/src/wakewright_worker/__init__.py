"""Wakewright worker: judges wake word clips for the Wakewright parent.

The package is a headless core. `cli.main` is the console entry point; the
same pieces (configuration, judges, the job loop) are what a desktop wrapper
would drive.
"""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("wakewright-worker")
except PackageNotFoundError:  # running from a source tree that was never installed
    __version__ = "0.0.0"
