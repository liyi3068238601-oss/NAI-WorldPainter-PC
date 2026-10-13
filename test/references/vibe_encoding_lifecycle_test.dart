import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/references/vibe_library.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'user cancellation settles encode-only Vibe without changing draft',
    () async {
      final pendingEncode = Completer<VibeLibraryEntry>();
      var cancelRequests = 0;
      final reference = _reference();
      final controller = WorkbenchController(
        vibeLibrary: VibeLibrary(),
        encodeVibe: _pendingEncoder(pendingEncode),
        cancelRequest: () {
          cancelRequests++;
          if (!pendingEncode.isCompleted) {
            pendingEncode.completeError(const FormatException('任务已取消'));
          }
        },
      );
      _configure(controller, reference);

      final operation = controller.saveVibeReference(reference, 'Will cancel');
      final operationResult = expectLater(
        operation,
        throwsA(isA<FormatException>()),
      );
      expect(controller.encodingVibe, isTrue);

      controller.cancelVibeEncoding();

      expect(cancelRequests, 1);
      // Cancellation requests settlement; the busy flag remains set until the
      // encoder future has actually unwound through saveVibeReference.
      expect(controller.encodingVibe, isTrue);
      await operationResult;

      expect(controller.encodingVibe, isFalse);
      expect(controller.generating, isFalse);
      expect(controller.vibeLibrary.entries, isEmpty);
      _expectDraftStillHas(controller, reference);
      controller.dispose();
    },
  );

  test('closing cancels and settles encode-only Vibe promptly', () async {
    final pendingEncode = Completer<VibeLibraryEntry>();
    var cancelRequests = 0;
    final reference = _reference();
    final controller = WorkbenchController(
      vibeLibrary: VibeLibrary(),
      encodeVibe: _pendingEncoder(pendingEncode),
      cancelRequest: () {
        cancelRequests++;
        if (!pendingEncode.isCompleted) {
          pendingEncode.completeError(const FormatException('任务已取消'));
        }
      },
    );
    _configure(controller, reference);

    final operation = controller.saveVibeReference(reference, 'Close cancel');
    final operationResult = expectLater(
      operation,
      throwsA(isA<FormatException>()),
    );
    expect(controller.encodingVibe, isTrue);

    await controller.closeStorage().timeout(const Duration(seconds: 2));
    await operationResult;

    expect(cancelRequests, 1);
    expect(controller.encodingVibe, isFalse);
    expect(controller.generating, isFalse);
    expect(controller.vibeLibrary.entries, isEmpty);
    _expectDraftStillHas(controller, reference);
    controller.dispose();
  });
}

EncodeVibe _pendingEncoder(Completer<VibeLibraryEntry> pending) =>
    ({
      required String sourceAssetRef,
      required String title,
      required String model,
      required ServiceConnection connection,
      double informationExtracted = 1.0,
      double strength = 0.3,
    }) => pending.future;

VibeReference _reference() => const VibeReference(
  assetId: 'source-asset',
  strength: 0.46,
  informationExtracted: 0.71,
);

void _configure(WorkbenchController controller, VibeReference reference) {
  controller
    ..updateProvider(ServiceConnection.labels['gateway7877']!)
    ..updateConnection(
      const ServiceConnection(
        protocol: 'gateway7877',
        baseUrl: 'https://mock.example',
      ),
    )
    ..updateAdvanced(
      GenerationParameters(
        model: 'nai-v4.5-curated',
        prompt: 'cancel encode-only Vibe',
        width: 832,
        height: 1216,
        vibeReferences: [reference],
      ),
    );
}

void _expectDraftStillHas(
  WorkbenchController controller,
  VibeReference reference,
) {
  final restoredReference = controller.parameters.vibeReferences.single;
  expect(identical(restoredReference, reference), isTrue);
  expect(restoredReference.assetId, 'source-asset');
  expect(restoredReference.encodedVibe, isNull);
  expect(restoredReference.encodedVibeScope, isNull);
  expect(restoredReference.strength, 0.46);
  expect(restoredReference.informationExtracted, 0.71);
}
