import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/workspace_store.dart';

void main() {
  test('receipt excludes a concurrent derived gallery result', () async {
    final started = Completer<void>();
    final response = Completer<SceneResult>();
    final workbench = WorkbenchController(
      generateImage: (_, _) {
        started.complete();
        return response.future;
      },
    );
    addTearDown(workbench.dispose);

    final pending = workbench.generateForAssistant(
      submitted: _submittedParameters(),
      submittedConnection: _connection,
      count: 1,
    );
    await started.future;
    workbench.addDerived(_result('concurrent-derived'));
    final generated = _result('assistant-generated');
    response.complete(generated);

    final receipt = await pending;

    expect(receipt.requested, 1);
    expect(receipt.attempted, 1);
    expect(receipt.results, hasLength(1));
    expect(receipt.results.single, same(generated));
    expect(
      workbench.results.map((result) => result.id),
      containsAll(['concurrent-derived', 'assistant-generated']),
    );
    expect(receipt.results.map((result) => result.id), ['assistant-generated']);
    expect(receipt.complete, isTrue);
  });

  test(
    'two-image partial failure records both attempts and one result',
    () async {
      var posts = 0;
      final workbench = WorkbenchController(
        generateImage: (_, _) async {
          posts++;
          if (posts == 1) return _result('first-image');
          throw StateError('synthetic second request failure');
        },
      );
      addTearDown(workbench.dispose);

      final receipt = await workbench.generateForAssistant(
        submitted: _submittedParameters(),
        submittedConnection: _connection,
        count: 2,
      );

      expect(posts, 2);
      expect(receipt.requested, 2);
      expect(receipt.attempted, 2);
      expect(receipt.results.map((result) => result.id), ['first-image']);
      expect(
        workbench.results.map((result) => result.id),
        contains('first-image'),
      );
      expect(receipt.persisted, isTrue);
      expect(receipt.error, isNotNull);
      expect(receipt.complete, isFalse);
    },
  );

  test(
    'post-processing failure retains raw image and stops the batch',
    () async {
      var posts = 0;
      var processCalls = 0;
      final raw = _result('raw-image-after-compose-failure');
      final workbench = WorkbenchController(
        generateImage: (_, _) async {
          posts++;
          return raw;
        },
      );
      addTearDown(workbench.dispose);

      final receipt = await workbench.generateForAssistant(
        submitted: _submittedParameters(),
        submittedConnection: _connection,
        count: 2,
        processResult: (_, _) async {
          processCalls++;
          throw StateError('synthetic local composite failure');
        },
      );

      expect(posts, 1);
      expect(processCalls, 1);
      expect(receipt.requested, 2);
      expect(receipt.attempted, 1);
      expect(receipt.results, hasLength(1));
      expect(receipt.results.single, same(raw));
      expect(
        workbench.results.map((result) => result.id),
        contains('raw-image-after-compose-failure'),
      );
      expect(receipt.postProcessingFailed, isTrue);
      expect(receipt.error, contains('本地合成失败'));
      expect(receipt.complete, isFalse);
    },
  );

  test('cancellation during post-processing retains received raw image and stops the batch', () async {
    final processingStarted = Completer<void>();
    final continueProcessing = Completer<void>();
    final raw = _result('raw-image-after-compose-cancel');
    var posts = 0;
    final workbench = WorkbenchController(
      generateImage: (_, _) async {
        posts++;
        return raw;
      },
    );
    addTearDown(workbench.dispose);

    final pending = workbench.generateForAssistant(
      submitted: _submittedParameters(),
      submittedConnection: _connection,
      count: 2,
      processResult: (received, isCurrent) async {
        expect(received, same(raw));
        processingStarted.complete();
        await continueProcessing.future;
        if (!isCurrent()) {
          throw const FormatException('synthetic composition cancellation');
        }
        return received;
      },
    );

    await processingStarted.future;
    workbench.cancelGeneration();
    continueProcessing.complete();
    final receipt = await pending;

    expect(posts, 1);
    expect(receipt.requested, 2);
    expect(receipt.attempted, 1);
    expect(receipt.cancelled, isTrue);
    expect(receipt.results, hasLength(1));
    expect(receipt.results.single, same(raw));
    expect(
      workbench.results.map((result) => result.id),
      contains('raw-image-after-compose-cancel'),
    );
    expect(receipt.error, contains('原始图片已保留'));
    expect(receipt.complete, isFalse);
  });

  test(
    'image asset save failure marks the received result unpersisted',
    () async {
      var posts = 0;
      final workbench = WorkbenchController(
        generateImage: (_, _) async {
          posts++;
          // GenerationRuntime throws this after receiving image bytes when it
          // cannot save the response into the managed image asset store.
          throw const ImageAssetStoreException(
            'synthetic image asset save failure',
          );
        },
      );
      addTearDown(workbench.dispose);

      final receipt = await workbench.generateForAssistant(
        submitted: _submittedParameters(),
        submittedConnection: _connection,
        count: 1,
      );

      expect(posts, 1);
      expect(receipt.attempted, 1);
      expect(receipt.results, isEmpty);
      expect(receipt.persisted, isFalse);
      expect(receipt.error, contains('图像资产读写失败'));
      expect(receipt.complete, isFalse);
    },
  );

  test(
    'failed gallery flush returns the generated result as not persisted',
    () async {
      const resultId = 'generated-but-not-saved';
      final store = _FailingGallerySaveStore(resultId);
      final generated = _result(resultId);
      var posts = 0;
      final workbench = WorkbenchController(
        store: store,
        generateImage: (_, _) async {
          posts++;
          return generated;
        },
      );
      addTearDown(workbench.dispose);

      final receipt = await workbench.generateForAssistant(
        submitted: _submittedParameters(),
        submittedConnection: _connection,
        count: 1,
      );

      expect(posts, 1);
      expect(receipt.results, hasLength(1));
      expect(receipt.results.single, same(generated));
      expect(workbench.results.map((result) => result.id), contains(resultId));
      expect(store.failedGallerySaves, 1);
      expect(receipt.persisted, isFalse);
      expect(receipt.complete, isFalse);
    },
  );

  test(
    'cancelled request late reply is not indexed or included in receipt',
    () async {
      final started = Completer<void>();
      final response = Completer<SceneResult>();
      var posts = 0;
      var cancellations = 0;
      final workbench = WorkbenchController(
        generateImage: (_, _) {
          posts++;
          started.complete();
          return response.future;
        },
        cancelRequest: () => cancellations++,
      );
      addTearDown(workbench.dispose);

      final pending = workbench.generateForAssistant(
        submitted: _submittedParameters(),
        submittedConnection: _connection,
        count: 1,
      );
      await started.future;
      workbench.cancelGeneration();
      response.complete(_result('late-server-reply'));

      final receipt = await pending;

      expect(posts, 1);
      expect(cancellations, 1);
      expect(receipt.requested, 1);
      expect(receipt.attempted, 1);
      expect(receipt.cancelled, isTrue);
      expect(receipt.results, isEmpty);
      expect(
        workbench.results.map((result) => result.id),
        isNot(contains('late-server-reply')),
      );
      expect(receipt.complete, isFalse);
    },
  );

  test('busy and over-limit calls are rejected before another POST', () async {
    final started = Completer<void>();
    final response = Completer<SceneResult>();
    var posts = 0;
    final workbench = WorkbenchController(
      generateImage: (_, _) {
        posts++;
        started.complete();
        return response.future;
      },
    );
    addTearDown(workbench.dispose);

    final overLimit = await workbench.generateForAssistant(
      submitted: _submittedParameters(),
      submittedConnection: _connection,
      count: 3,
    );
    expect(overLimit.requested, 3);
    expect(overLimit.attempted, 0);
    expect(overLimit.error, isNotNull);
    expect(overLimit.complete, isFalse);
    expect(posts, 0);

    final active = workbench.generateForAssistant(
      submitted: _submittedParameters(),
      submittedConnection: _connection,
      count: 1,
    );
    await started.future;
    final busy = await workbench.generateForAssistant(
      submitted: _submittedParameters(),
      submittedConnection: _connection,
      count: 2,
    );

    expect(busy.requested, 2);
    expect(busy.attempted, 0);
    expect(busy.error, isNotNull);
    expect(busy.complete, isFalse);
    expect(posts, 1);

    response.complete(_result('active-image'));
    final activeReceipt = await active;
    expect(activeReceipt.results.map((result) => result.id), ['active-image']);
    expect(posts, 1);
  });
}

const _connection = ServiceConnection(
  protocol: 'official',
  baseUrl: ServiceConnection.officialUrl,
);

GenerationParameters _submittedParameters() => GenerationParameters(
  model: 'nai-diffusion-5-full',
  prompt: 'synthetic submitted prompt',
  negativePrompt: 'synthetic negative prompt',
  width: 768,
  height: 1024,
  seed: 42,
);

SceneResult _result(String id) => SceneResult(
  id: id,
  title: id,
  prompt: 'synthetic submitted prompt',
  negative: 'synthetic negative prompt',
  width: 768,
  height: 1024,
  seed: 42,
  variant: 0,
  favorite: false,
  isDemo: false,
  model: 'NAI Diffusion 5 Full',
  provider: 'NovelAI 官方',
  steps: 28,
  cfg: 5,
);

class _FailingGallerySaveStore implements WorkspaceStore {
  _FailingGallerySaveStore(this.failResultId);

  final String failResultId;
  int _revision = 0;
  int failedGallerySaves = 0;
  StoredWorkspace? _stored;

  @override
  String get label => 'generation receipt test store';

  @override
  Future<StoredWorkspace?> load() async => _stored;

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    final gallery = data['gallery'];
    final containsResult =
        gallery is List &&
        gallery.any((item) => item is Map && item['id'] == failResultId);
    if (containsResult) {
      failedGallerySaves++;
      throw StateError('synthetic generated gallery flush failure');
    }
    if (expectedRevision != _revision) {
      throw WorkspaceConflictException(
        expectedRevision: expectedRevision,
        actualRevision: _revision,
      );
    }
    _revision++;
    _stored = StoredWorkspace(data: data, revision: _revision);
    return _revision;
  }

  @override
  Future<void> close() async {}
}
