import 'credential_vault_contract.dart';

/// Web-only fallback. This is session memory, not persistent credential
/// protection; reloading or closing the page discards every entry.
class SessionMemoryCredentialVault implements CredentialVault {
  final Map<String, String> _values = <String, String>{};

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {
    validateCredentialScope(provider: provider, key: key);
    validateCredentialSecret(secret);
    _values[_mapKey(provider, key)] = secret;
  }

  @override
  Future<String?> read({required String provider, required String key}) async {
    validateCredentialScope(provider: provider, key: key);
    return _values[_mapKey(provider, key)];
  }

  @override
  Future<void> delete({required String provider, required String key}) async {
    validateCredentialScope(provider: provider, key: key);
    _values.remove(_mapKey(provider, key));
  }

  String _mapKey(String provider, String key) => '$provider\u0000$key';
}

final SessionMemoryCredentialVault _sessionVault =
    SessionMemoryCredentialVault();

CredentialVault createCredentialVault() => _sessionVault;
