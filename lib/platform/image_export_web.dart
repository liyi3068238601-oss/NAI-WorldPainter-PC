import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

Future<bool> exportImageImpl(Uint8List bytes, String suggestedName) async {
  final blob = web.Blob(
    <JSAny>[bytes.toJS].toJS,
    web.BlobPropertyBag(type: 'image/png'),
  );
  final objectUrl = web.URL.createObjectURL(blob);
  final anchor = web.HTMLAnchorElement()
    ..href = objectUrl
    ..download = suggestedName;
  final body = web.document.body;
  if (body == null) {
    web.URL.revokeObjectURL(objectUrl);
    return false;
  }

  try {
    body.append(anchor);
    // A browser that does not reflect the download attribute cannot reliably
    // honor this request; report it as unsupported rather than opening the PNG.
    if (anchor.download != suggestedName) return false;
    anchor.click();
    return true;
  } catch (_) {
    return false;
  } finally {
    anchor.remove();
    web.window.setTimeout(
      (() => web.URL.revokeObjectURL(objectUrl)).toJS,
      null,
      60 * 1000,
    );
  }
}
