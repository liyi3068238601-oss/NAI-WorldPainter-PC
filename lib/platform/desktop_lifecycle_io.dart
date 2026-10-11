import 'package:flutter/services.dart';

class DesktopLifecycle {
  static const MethodChannel _channel = MethodChannel('worldpainter/window');

  static Future<bool> Function()? _onClose;
  static bool _installed = false;

  static void install(Future<bool> Function() onClose) {
    _onClose = onClose;
    if (_installed) {
      return;
    }
    _installed = true;
    _channel.setMethodCallHandler(_handleMethodCall);
  }

  static void uninstall() {
    _onClose = null;
    if (!_installed) {
      return;
    }
    _installed = false;
    _channel.setMethodCallHandler(null);
  }

  static Future<Object?> _handleMethodCall(MethodCall call) async {
    if (call.method != 'requestClose') {
      throw MissingPluginException(
        'Unsupported desktop lifecycle method: ${call.method}',
      );
    }
    final onClose = _onClose;
    if (onClose == null) {
      return false;
    }
    return onClose();
  }
}
