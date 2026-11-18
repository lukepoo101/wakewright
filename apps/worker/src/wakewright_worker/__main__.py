"""`python -m wakewright_worker` is the same as `wakewright-worker`."""

import sys

from wakewright_worker.cli import main

sys.exit(main())
