# Third-party notices

This file records third-party software vendored into this repository, or
shipped by the site under a license that asks for notice, with its license.
Add an entry when another one is vendored.

---

## tungstenite (vendored copy)

`collaboration-rs/third_party/tungstenite` is the `tungstenite` 0.29.0 crate
from crates.io (upstream https://github.com/snapview/tungstenite-rs). Its
sources are byte-identical to the published package apart from the changes
below, each marked "Patched for Capy" in the code (Epo 2026-10-11 and
2026-10-12):

- `FrameCodec::write_out_buffer` (`src/protocol/frame/mod.rs`) gives back a
  write buffer grown past 64 KiB (`BUFFER_KEEP`) once it is written, so a
  socket does not keep a buffer the size of the largest message it was sent;
- `FrameCodec::read_frame` moves the bytes after a frame past 64 KiB to a
  fresh read buffer, so a socket does not keep (and reclaim) a buffer the
  size of the largest frame it received;
- `FrameCodec::out_buffer_capacity`, `FrameCodec::in_buffer_capacity`,
  `WebSocket::write_buffer_capacity` and `WebSocket::read_buffer_capacity`
  (`src/protocol/mod.rs`) read those buffers' capacity, for
  `collaboration-rs/crates/server/tests/socket_buffers.rs`.

Copyright (c) 2017 Alexey Galakhov; Copyright (c) 2016 Jason Housley.

License: MIT or Apache License, Version 2.0, at your option. The vendored
directory ships both texts (`LICENSE-MIT`, `LICENSE-APACHE`).

---

## HSK 3.0 word list (derived data)

`pipeline/pipeline/retrieval/hsk_words.tsv` (and its bench copy
`bench/rag/fixtures/hints-eval/hsk-levels.tsv`) lists the HSK 3.0 words with
their lowest level and their Traditional forms, taken from `complete.min.json`
of complete-hsk-vocabulary (https://github.com/drkameleon/complete-hsk-vocabulary).
Only the words, levels and Traditional forms are kept; the hints matcher uses
them to split Chinese messages into words (Epo 2026-10-20).

Copyright (c) 2026 Yanis Zafirópulos.

License: MIT. The full text is in each file's header.

---

## libheif-js, libheif and libde265 (HEIC/HEIF decoder)

The site loads `libheif-js` 1.23.5 from npm
(https://github.com/catdad-experiments/libheif-js) at runtime, only when an
HEIC or HEIF image is picked (`src/lib/decodeImage.ts`, Epo 2026-10-24, Q294,
Q333). Its `libheif-wasm/libheif-bundle.mjs` holds libheif
(https://github.com/strukturag/libheif) and its HEVC decoder libde265
(https://github.com/strukturag/libde265) compiled to WebAssembly, at the
versions its build script pins
(https://github.com/catdad-experiments/libheif-js/blob/v1.23.5/scripts/install.js).
The module ships unmodified as its own file, never bundled with Capy's code,
so a compatible build can replace it.

Copyright (c) struktur AG (libheif, libde265); Kiril Vatev (libheif-js).

License: GNU Lesser General Public License, version 3 (libheif-js, libheif and
libde265). The site serves this notice with the package's license texts at
`/licenses/libheif-js.txt` (`public/licenses/libheif-js.txt`); the LGPL is also
at https://www.gnu.org/licenses/lgpl-3.0.html.

---

## UTIF.js (utif2) and pako (TIFF decoder)

`utif2` 4.1.0 from npm (https://github.com/photopea/UTIF.js) decodes TIFF
sources in a chunk loaded only for one (`src/lib/decodeImage.ts`); it inflates
Deflate-compressed TIFFs with `pako` 1.0.11 (https://github.com/nodeca/pako).

Copyright (c) 2017 Photopea (UTIF.js); Copyright (C) 2014-2017 Vitaly Puzrin
and Andrei Tuputcyn (pako).

License: MIT (both). Each package ships the text (`LICENSE`).

---

## pdf.js image decoders and OpenJPEG (JPEG 2000 decoder)

JPEG 2000 sources are decoded by `pdfjs-dist` 4.8.69's
`image_decoders/pdf.image_decoders.mjs` (https://github.com/mozilla/pdf.js),
whose `JpxImage` runs OpenJPEG (https://github.com/uclouvain/openjpeg)
compiled to WebAssembly, in a chunk loaded only for one.

Copyright 2024 Mozilla Foundation (pdf.js); the OpenJPEG authors and
Université catholique de Louvain (OpenJPEG).

License: Apache License, Version 2.0 (pdf.js); BSD 2-Clause (OpenJPEG).
