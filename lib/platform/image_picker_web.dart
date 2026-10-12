import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

Future<Uint8List?> pickImage() async {
  final done = Completer<Uint8List?>();
  final input = web.HTMLInputElement()
    ..type = 'file'
    ..accept = 'image/png,image/jpeg,image/webp';
  input.onchange = ((web.Event event) {
    () async {
      try {
        final file = input.files?.item(0);
        if (file == null) {
          done.complete(null);
        } else if (file.size > 30 * 1024 * 1024) {
          done.completeError(const FormatException('图片不能超过 30 MB'));
        } else {
          final buffer = await file.arrayBuffer().toDart;
          done.complete(buffer.toDart.asUint8List());
        }
      } catch (_) {
        if (!done.isCompleted) {
          done.completeError(const FormatException('无法读取所选图片'));
        }
      }
    }();
  }).toJS;
  input.oncancel = ((web.Event event) {
    if (!done.isCompleted) done.complete(null);
  }).toJS;
  input.click();
  try {
    return await done.future;
  } finally {
    input.onchange = null;
    input.oncancel = null;
    input.remove();
  }
}
