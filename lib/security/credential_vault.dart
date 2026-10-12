import 'credential_vault_contract.dart';
import 'credential_vault_method_channel.dart'
    if (dart.library.js_interop) 'credential_vault_web.dart'
    as platform;

export 'credential_vault_contract.dart';

/// Creates the credential backend for the current platform.
///
/// Windows uses the native Credential Manager channel. Web uses an in-memory
/// vault whose contents are lost when the page reloads or closes.
CredentialVault createCredentialVault() => platform.createCredentialVault();
