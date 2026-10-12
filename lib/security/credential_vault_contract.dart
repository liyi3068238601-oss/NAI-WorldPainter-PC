import 'dart:convert';

/// Stores provider credentials without exposing storage details to callers.
abstract interface class CredentialVault {
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  });

  Future<String?> read({required String provider, required String key});

  Future<void> delete({required String provider, required String key});
}

/// Raised when a scope or secret does not fit the vault contract.
///
/// The exception deliberately does not include caller-supplied values.
class CredentialInputException implements Exception {
  const CredentialInputException();

  @override
  String toString() => 'Credential input is invalid.';
}

/// Raised when the platform credential backend cannot complete an operation.
///
/// The exception deliberately does not include native error text or secrets.
class CredentialVaultException implements Exception {
  const CredentialVaultException();

  @override
  String toString() => 'Credential storage is unavailable.';
}

const int maxCredentialSecretBytes = 5 * 512;

void validateCredentialScope({required String provider, required String key}) {
  if (!_isScopeSegment(provider) || !_isScopeSegment(key)) {
    throw const CredentialInputException();
  }
}

void validateCredentialSecret(String secret) {
  if (secret.isEmpty || secret.contains('\u0000')) {
    throw const CredentialInputException();
  }

  try {
    if (utf8.encode(secret).length > maxCredentialSecretBytes) {
      throw const CredentialInputException();
    }
  } on FormatException {
    throw const CredentialInputException();
  }
}

bool _isScopeSegment(String value) {
  if (value.isEmpty || value.length > 64) {
    return false;
  }
  final first = value.codeUnitAt(0);
  if (!_isAsciiAlphaNumeric(first)) {
    return false;
  }
  for (final codeUnit in value.codeUnits) {
    if (!_isAsciiAlphaNumeric(codeUnit) &&
        codeUnit != 0x2e && // .
        codeUnit != 0x5f && // _
        codeUnit != 0x2d) {
      // -
      return false;
    }
  }
  return true;
}

bool _isAsciiAlphaNumeric(int value) =>
    (value >= 0x30 && value <= 0x39) ||
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a);
