import 'dart:io';

import 'package:flutter/services.dart';

Future<bool> exportImageImpl(Uint8List bytes, String suggestedName) async {
  if (!Platform.isWindows) return false;

  try {
    return await const MethodChannel('worldpainter/files').invokeMethod<bool>(
          'savePng',
          <String, Object>{'bytes': bytes, 'suggestedName': suggestedName},
        ) ??
        false;
  } on MissingPluginException {
    return false;
  }
}
