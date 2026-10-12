import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../platform/desktop_lifecycle.dart';
import 'credential_vault.dart';

const MethodChannel _windowChannel = MethodChannel('worldpainter/window');
const Duration _probeTimeout = Duration(seconds: 15);
const String _probeProvider = 'worldpainter_probe';
const String _probeSecret = 'synthetic-worldpainter-credential-probe-v1';

/// Runs one hidden Windows Credential Manager phase when requested.
///
/// Invoke with `--storage-probe --credential-probe --phase=write|read` and
/// `--run-key=random-lowercase-id`. The write and read phases use the same
/// run key in separate process launches. Output contains only phase/result.
/// Returns true when this process was owned by the probe.
Future<bool> runWindowsCredentialProbe(List<String> args) async {
  if (!args.contains('--credential-probe')) {
    return false;
  }

  final phase = _readOption(args, '--phase');
  final runKey = _readOption(args, '--run-key');
  if ((phase != 'write' && phase != 'read') || !_isRunKey(runKey)) {
    stderr.writeln('CREDENTIAL_PROBE result=FAIL code=invalid_arguments');
    exit(2);
  }

  final key = 'run_$runKey';
  var resultCode = 'ok';
  final vault = createCredentialVault();
  try {
    if (phase == 'write') {
      await vault.save(
        provider: _probeProvider,
        key: key,
        secret: _probeSecret,
      );
      if (await vault.read(provider: _probeProvider, key: key) !=
          _probeSecret) {
        resultCode = 'round_trip_failed';
        await _tryDelete(vault, key);
      }
    } else {
      final stored = await vault.read(provider: _probeProvider, key: key);
      final matchesFixture = stored == _probeSecret;
      await vault.delete(provider: _probeProvider, key: key);
      final isMissing =
          await vault.read(provider: _probeProvider, key: key) == null;
      if (!matchesFixture || !isMissing) {
        resultCode = 'read_delete_failed';
      }
    }
  } catch (_) {
    resultCode = 'credential_operation_failed';
    await _tryDelete(vault, key);
  }

  var closeSucceeded = false;
  try {
    DesktopLifecycle.install(() async => true);
    runApp(const SizedBox.shrink());
    closeSucceeded =
        await _windowChannel
            .invokeMethod<bool>('probeClose')
            .timeout(_probeTimeout) ==
        true;
  } catch (_) {
    closeSucceeded = false;
  }

  if (closeSucceeded && resultCode == 'ok') {
    stdout.writeln('CREDENTIAL_PROBE phase=$phase result=PASS');
    return true;
  }
  stderr.writeln(
    'CREDENTIAL_PROBE phase=$phase result=FAIL code=${closeSucceeded ? resultCode : 'runner_close_failed'}',
  );
  exit(1);
}

Future<void> _tryDelete(CredentialVault vault, String key) async {
  try {
    await vault.delete(provider: _probeProvider, key: key);
  } catch (_) {
    // Keep reports generic; cleanup failures are reported by the caller.
  }
}

String? _readOption(List<String> args, String name) {
  final prefix = '$name=';
  for (var index = 0; index < args.length; index++) {
    final argument = args[index];
    if (argument.startsWith(prefix)) {
      return argument.substring(prefix.length);
    }
    if (argument == name && index + 1 < args.length) {
      return args[index + 1];
    }
  }
  return null;
}

bool _isRunKey(String? value) {
  if (value == null || value.isEmpty || value.length > 48) {
    return false;
  }
  for (final unit in value.codeUnits) {
    final isLowerAlpha = unit >= 0x61 && unit <= 0x7a;
    final isDigit = unit >= 0x30 && unit <= 0x39;
    if (!isLowerAlpha && !isDigit && unit != 0x2d) {
      return false;
    }
  }
  return true;
}
