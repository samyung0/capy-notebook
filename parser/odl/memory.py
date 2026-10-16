"""What running out of memory looks like in a parse child: the parse turns it
into ParseOOM (app.py), and no stage may read it as an ordinary error."""

from __future__ import annotations

import errno
import re

# MuPDF's failed allocation as PyMuPDF raises it: its message starts with
# MuPDF's error code (text inside another error, such as Java's output, is
# not one).
_ALLOCATION_FAILED = re.compile(r"code=\d+: (?:m|c|re)alloc \([^)]*\) failed")


def out_of_memory(exc: BaseException) -> bool:
    """Past the child's address-space limit: Python's MemoryError, an OS call
    refused with ENOMEM, or MuPDF's failed allocation."""
    return (
        isinstance(exc, MemoryError)
        or (isinstance(exc, OSError) and exc.errno == errno.ENOMEM)
        or bool(_ALLOCATION_FAILED.match(str(exc)))
    )
