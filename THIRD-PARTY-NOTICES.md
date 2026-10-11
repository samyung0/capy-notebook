# Third-party notices

This file records third-party software vendored into this repository, with
its license. Add an entry when another one is vendored.

---

## tungstenite (vendored copy)

`collaboration-rs/third_party/tungstenite` is the `tungstenite` 0.29.0 crate
from crates.io (upstream https://github.com/snapview/tungstenite-rs). Its
sources are byte-identical to the published package apart from the changes
below, each marked "Patched for Capy" in the code (Epo 2026-10-11):

- `FrameCodec::write_out_buffer` (`src/protocol/frame/mod.rs`) gives back a
  write buffer grown past 64 KiB (`OUT_BUFFER_KEEP`) once it is written, so a
  socket does not keep a buffer the size of the largest message it was sent;
- `FrameCodec::out_buffer_capacity` and `WebSocket::write_buffer_capacity`
  (`src/protocol/mod.rs`) read that buffer's capacity, for
  `collaboration-rs/crates/server/tests/write_buffer.rs`.

Copyright (c) 2017 Alexey Galakhov; Copyright (c) 2016 Jason Housley.

License: MIT or Apache License, Version 2.0, at your option. The vendored
directory ships both texts (`LICENSE-MIT`, `LICENSE-APACHE`).
