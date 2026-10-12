import 'credential_vault_probe_stub.dart'
    if (dart.library.io) 'credential_vault_probe_io.dart'
    as platform;

/// Runs the hidden native credential probe on IO platforms.
///
/// Web builds return false because they do not provide Windows Credential
/// Manager storage.
Future<bool> runWindowsCredentialProbe(List<String> args) =>
    platform.runWindowsCredentialProbe(args);
