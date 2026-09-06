"""Every prompt this system sends to a provider, one module per model slot.

A function here takes the surrounding context and returns what goes into the
request: the message list for most calls, a bare string where the caller owns
the wrapping. Nothing here opens a connection, reads the database, or resolves
a model — a prompt must be constructible in a test with no network and no pin.

Where a prompt's text is part of a cache key, the version constant lives in the
same module, so the two are edited together.
"""
