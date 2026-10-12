import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/workspace_store.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';

void main() {
  test('close waits for a previously cancelled request and never indexes its result', () async {
    final response = Completer<SceneResult>();
    final started = Completer<void>();
    final c = WorkbenchController(
      generateImage: (_, _) {
        started.complete();
        return response.future;
      },
    );
    final pending = c.generate();
    await started.future;
    c.cancelGeneration();
    var closed = false;
    final closing = c.closeStorage().then((_) => closed = true);
    await Future<void>.delayed(Duration.zero);
    expect(closed, isFalse);
    response.complete(c.selected);
    await pending;
    await closing;
    expect(closed, isTrue);
    expect(c.results, hasLength(3));
    c.dispose();
  });

  test(
    'legacy workspace migrates role coordinates without discarding its draft',
    () {
      final original = WorkbenchController();
      original.updatePrompt('legacy draft');
      final data = jsonDecode(
        jsonEncode(original.exportWorkspace()),
      ) as Map<String, dynamic>;
      (data['draft'] as Map).remove('generation');
      (data['draft'] as Map).remove('connections');
      (data['draft'] as Map).remove('batchCount');
      data['editor'] = {
        'character': 'Aster',
        'characterEnabled': true,
        'position': 'B2',
        'brush': 22,
        'masks': {},
        'redo': {},
      };
      final restored = WorkbenchController(
        restored: StoredWorkspace(data: data, revision: 3),
      );
      expect(restored.prompt, 'legacy draft');
      expect(restored.parameters.characters.single.centerX, .3);
      expect(restored.parameters.characters.single.centerY, .3);
      expect(restored.batchCount, 1);
      original.dispose();
      restored.dispose();
    },
  );

  test(
    'credential scope is isolated by protocol and complete endpoint',
    () async {
      final vault = SessionMemoryCredentialVault();
      const first = ServiceConnection(
        protocol: 'ikun',
        baseUrl: 'https://mock.example/api/',
      );
      const same = ServiceConnection(
        protocol: 'ikun',
        baseUrl: 'https://mock.example/api',
      );
      const different = ServiceConnection(
        protocol: 'ikun',
        baseUrl: 'https://mock.example/other',
      );
      const protocol = ServiceConnection(
        protocol: 'gateway7877',
        baseUrl: 'https://mock.example/api',
      );
      await first.saveSecret(vault, 'synthetic-scope-fixture');
      expect(await same.readSecret(vault), 'synthetic-scope-fixture');
      expect(await different.readSecret(vault), isNull);
      expect(await protocol.readSecret(vault), isNull);
      expect(
        jsonEncode(first.toJson()),
        isNot(contains('synthetic-scope-fixture')),
      );
      expect(
        () => const ServiceConnection(
          protocol: 'official',
          baseUrl: 'https://mock.example',
        ).uri,
        throwsFormatException,
      );
    },
  );
}
