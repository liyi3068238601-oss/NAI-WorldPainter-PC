# Image metadata parser source note

Implementation: `lib/metadata/image_metadata_parser.dart` is an independent
Dart implementation. No source files were copied from the references below.

- `YILING0013/novelai_local_web`, commit
  `aa0fcbe477eae0a703ec47740785f9419d7d5cbe`; inspected
  `nai_flask/api_utils/image_metadata.py` for carrier-format observations:
  15-byte `stealth_png*` alpha and `stealth_rgb*` RGB signatures, a big-endian
  bit length, column-major least-significant-bit ordering, and gzip payloads.
  The project carries AGPL-3.0; only the file format behavior was used as
  reference, not its implementation.
  RGB carrier extraction is a constrained best-effort fallback: it is tried
  only for fully opaque decoded images. Flutter exposes premultiplied RGBA
  pixels, which can lose RGB low bits at partial alpha; those images skip RGB
  extraction with a warning. Alpha-carrier extraction remains available.
- NovelAI PNG metadata supports `tEXt`, `iTXt`, and `zTXt`; those chunk formats
  are parsed according to the PNG structure and use bounded zlib decoding.

The parser projects only known generation fields, validates CRC and structural
bounds, caps compressed text/stealth expansion at 4 MiB, caps source bytes at
64 MiB, and limits stealth image decoding to 16 megapixels. Unknown metadata,
paths, and URLs are not returned or resolved.
