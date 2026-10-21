"""What running out of memory looks like in a parse child: the parse turns it
into ParseOOM (app.py), and no stage may read it as an ordinary error. Also
how a parse child hands freed memory back to the kernel."""

from __future__ import annotations

import ctypes
import errno
import gc
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


def release_memory() -> None:
    """Hand the heap a finished unit of work freed back to the kernel.

    glibc keeps freed arenas (about 0.8 GiB after a large document) otherwise,
    and MuPDF's store keeps decoded images and fonts (up to 256 MiB) of
    documents already closed.
    """
    import pymupdf

    pymupdf.TOOLS.store_shrink(100)
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass  # Not glibc (macOS development).
