import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/assistant/model_discovery.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/security/credential_vault.dart';

void main() {
  const provider = AssistantProvider(
    id: 'fixture',
    name: 'test',
    baseUrl: 'https://model.example/v1',
    model: 'discovery',
  );
  test('draft key is only used for this GET and cannot overwrite saved credentials', () async {
    final vault = _Vault()..values[provider.credentialKey] = 'saved-synthetic';
    final models = await discoverAssistantModels(
      provider: provider,
      vault: vault,
      cancellation: AgentCancellation(),
      draftSecret: 'unsaved-synthetic',
      clientFactory: () => MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.toString(), 'https://model.example/v1/models');
        expect(request.headers['authorization'], 'Bearer unsaved-synthetic');
        return http.Response(
          jsonEncode({
            'data': [
              {'id': 'model-b'},
              {'id': 'model-a'},
              {'id': 'model-b'},
            ],
          }),
          200,
        );
      }),
    );
    expect(models, ['model-a', 'model-b']);
    expect(vault.values[provider.credentialKey], 'saved-synthetic');
    expect(vault.writes, 0);
  });
  test('changing endpoint without a new draft key never reuses the old endpoint key', () async {
    final vault = _Vault()..values[provider.credentialKey] = 'saved-synthetic';
    const other = AssistantProvider(
      id: 'fixture',
      name: 'test',
      baseUrl: 'https://other.example/v1',
      model: 'discovery',
    );
    var calls = 0;
    await expectLater(
      discoverAssistantModels(
        provider: other,
        vault: vault,
        cancellation: AgentCancellation(),
        clientFactory: () {
          calls++;
          throw StateError('Must not contact endpoint');
        },
      ),
      throwsA(isA<AgentException>()),
    );
    expect(calls, 0);
    expect(vault.writes, 0);
  });
  test(
    'new connection discovery cannot use stored keys even if its ID collides',
    () async {
      final vault = _Vault()
        ..values[provider.credentialKey] = 'saved-synthetic';
      var calls = 0;
      await expectLater(
        discoverAssistantModels(
          provider: provider,
          vault: vault,
          cancellation: AgentCancellation(),
          useStoredKey: false,
          clientFactory: () {
            calls++;
            throw StateError('Must not contact endpoint');
          },
        ),
        throwsA(isA<AgentException>()),
      );
      expect(calls, 0);
      expect(vault.writes, 0);
    },
  );
}

class _Vault implements CredentialVault {
  final values = <String, String>{};
  int writes = 0;
  @override
  Future<String?> read({required String provider, required String key}) async =>
      values[key];
  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {
    writes++;
    values[key] = secret;
  }

  @override
  Future<void> delete({required String provider, required String key}) async {
    writes++;
    values.remove(key);
  }
}
