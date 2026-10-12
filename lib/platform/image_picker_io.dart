import 'package:flutter/services.dart';

Future<Uint8List?> pickImage() =>
    const MethodChannel('worldpainter/files')
        .invokeMethod<Uint8List>('pickImage');
