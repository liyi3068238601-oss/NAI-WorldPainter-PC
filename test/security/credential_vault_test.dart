import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/security/credential_vault.dart';
import 'package:worldpainter_pc/security/credential_vault_method_channel.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel(credentialMethodChannelName);
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
  });

  test(
    'method channel uses provider scoped save, read, and delete calls',
    () async {
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        if (call.method == 'read') {
          return 'synthetic-token';
        }
        return null;
      });

      final vault = MethodChannelCredentialVault(channel: channel);
      await vault.save(
        provider: 'novelai',
        key: 'official_token',
        secret: 'synthetic-token',
      );
      expect(
        await vault.read(provider: 'novelai', key: 'official_token'),
        'synthetic-token',
      );
      await vault.delete(provider: 'novelai', key: 'official_token');

      expect(calls.map((call) => call.method), <String>[
        'save',
        'read',
        'delete',
      ]);
      expect(calls.first.arguments, <String, Object?>{
        'provider': 'novelai',
        'key': 'official_token',
        'secret': 'synthetic-token',
      });
      expect(calls.last.arguments, <String, Object?>{
        'provider': 'novelai',
        'key': 'official_token',
      });
    },
  );

  test('invalid scope and oversized secret never reach the channel', () async {
    var callCount = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      callCount++;
      return null;
    });
    final vault = MethodChannelCredentialVault(channel: channel);

    await expectLater(
      vault.read(provider: '../escape', key: 'token'),
      throwsA(isA<CredentialInputException>()),
    );
    await expectLater(
      vault.save(
        provider: 'novelai',
        key: 'token',
        secret: 'x' * (maxCredentialSecretBytes + 1),
      ),
      throwsA(isA<CredentialInputException>()),
    );
    expect(callCount, 0);
  });

  test('native errors are collapsed without exposing their message', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      throw PlatformException(
        code: 'native_error',
        message: 'synthetic-token-must-not-escape',
      );
    });
    final vault = MethodChannelCredentialVault(channel: channel);

    await expectLater(
      vault.read(provider: 'novelai', key: 'token'),
      throwsA(
        isA<CredentialVaultException>().having(
          (error) => error.toString(),
          'safe message',
          isNot(contains('synthetic-token-must-not-escape')),
        ),
      ),
    );
  });

  test('web vault scopes values in session memory and deletes them', () async {
    final vault = SessionMemoryCredentialVault();
    await vault.save(
      provider: 'gateway_a',
      key: 'api_key',
      secret: 'synthetic-a',
    );
    await vault.save(
      provider: 'gateway_b',
      key: 'api_key',
      secret: 'synthetic-b',
    );

    expect(
      await vault.read(provider: 'gateway_a', key: 'api_key'),
      'synthetic-a',
    );
    expect(
      await vault.read(provider: 'gateway_b', key: 'api_key'),
      'synthetic-b',
    );
    await vault.delete(provider: 'gateway_a', key: 'api_key');
    expect(await vault.read(provider: 'gateway_a', key: 'api_key'), isNull);
    expect(
      await vault.read(provider: 'gateway_b', key: 'api_key'),
      'synthetic-b',
    );
  });
}
