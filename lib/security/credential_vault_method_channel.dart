import 'package:flutter/services.dart';

import 'credential_vault_contract.dart';

const String credentialMethodChannelName = 'worldpainter/credentials';

/// Flutter method-channel implementation used by desktop native runners.
class MethodChannelCredentialVault implements CredentialVault {
  MethodChannelCredentialVault({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(credentialMethodChannelName);

  final MethodChannel _channel;

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {
    validateCredentialScope(provider: provider, key: key);
    validateCredentialSecret(secret);
    await _invoke<void>('save', <String, Object?>{
      'provider': provider,
      'key': key,
      'secret': secret,
    });
  }

  @override
  Future<String?> read({required String provider, required String key}) async {
    validateCredentialScope(provider: provider, key: key);
    return _invoke<String?>('read', <String, Object?>{
      'provider': provider,
      'key': key,
    });
  }

  @override
  Future<void> delete({required String provider, required String key}) async {
    validateCredentialScope(provider: provider, key: key);
    await _invoke<void>('delete', <String, Object?>{
      'provider': provider,
      'key': key,
    });
  }

  Future<T?> _invoke<T>(String method, Map<String, Object?> arguments) async {
    try {
      return await _channel.invokeMethod<T>(method, arguments);
    } catch (_) {
      // Native errors are intentionally collapsed so they cannot echo secrets
      // or paths back into UI error messages and logs.
      throw const CredentialVaultException();
    }
  }
}

CredentialVault createCredentialVault() => MethodChannelCredentialVault();
