import 'package:http/http.dart' as http;

import '../security/credential_vault.dart';
import 'agent_contract.dart';
import 'openai_agent_transport.dart';

/// Unsaved connection fields are used only for this explicit discovery request.
/// A draft secret never enters the persistent vault or workspace.
Future<List<String>> discoverAssistantModels({
  required AssistantProvider provider,
  required CredentialVault vault,
  required AgentCancellation cancellation,
  String draftSecret = '',
  bool useStoredKey = true,
  http.Client Function()? clientFactory,
}) async {
  final transport = OpenAiAgentTransport(
    vault: _DiscoveryVault(provider, vault, draftSecret.trim(), useStoredKey),
    clientFactory: clientFactory,
  );
  final models = await transport.listModels(provider, cancellation);
  cancellation.check();
  return models
      .where((id) => id.length <= 200 && id.trim().isNotEmpty)
      .toSet()
      .toList()
    ..sort();
}

class _DiscoveryVault implements CredentialVault {
  _DiscoveryVault(
    this.connection,
    this.saved,
    this.draftSecret,
    this.useStoredKey,
  );
  final AssistantProvider connection;
  final CredentialVault saved;
  final String draftSecret;
  final bool useStoredKey;

  @override
  Future<String?> read({required String provider, required String key}) async {
    if (provider != 'assistant' || key != connection.credentialKey) {
      throw const CredentialInputException();
    }
    return draftSecret.isNotEmpty
        ? draftSecret
        : useStoredKey
        ? saved.read(provider: provider, key: key)
        : null;
  }

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async => throw StateError('Model discovery cannot save credentials.');
  @override
  Future<void> delete({required String provider, required String key}) async =>
      throw StateError('Model discovery cannot delete credentials.');
}
