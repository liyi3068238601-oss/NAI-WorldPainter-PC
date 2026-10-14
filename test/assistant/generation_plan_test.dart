import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/generation_plan.dart';
import 'package:worldpainter_pc/editing/image_editing_session.dart';
import 'package:worldpainter_pc/editing/inpaint_document.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

import '../image_editing_session_test.dart' as images;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory dir;
  late ImageAssetStore assets;
  late WorkbenchController c;
  late ImageEditingSession editing;
  setUp(() async {
    dir = await Directory('.tmp').createTemp('assistant-plan-');
    assets = await openImageAssetStore(directory: '${dir.path}/assets');
    c = WorkbenchController(assets: assets);
    editing = ImageEditingSession(
      assets: assets,
      onPersist: c.updateImageEditing,
    );
    final source = await assets.save(await images.solid(0xff204080));
    editing.setSource(source, parentId: 'fixture-parent');
    editing.changeDocument(editing.document!.copyWith(featherPixels: 0));
    editing.addStroke(
      InpaintStroke(
        target: InpaintTarget.mask,
        operation: InpaintOperation.paint,
        geometry: InpaintGeometry.rectangle,
        size: 8,
        rectangle: const ui.Rect.fromLTWH(16, 16, 16, 16),
      ),
    );
    c.setSize(64, 64);
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.inpaint),
    );
  });
  tearDown(() async {
    editing.dispose();
    c.dispose();
    await assets.close();
    await dir.delete(recursive: true);
  });
  Future<AssistantGenerationPlan> prepare() {
    final draft = c.assistantDraftFingerprint;
    return AssistantGenerationPlan.prepare(
      workbench: c,
      parameters: c.parameters,
      connection: c.connection,
      cancellation: AgentCancellation(),
      checkDraft: () {
        if (c.assistantDraftFingerprint != draft) {
          throw const AgentException('changed');
        }
      },
    );
  }

  test(
    'inpaint preview binds actual mask and composes a transparent layer',
    () async {
      final plan = await prepare();
      addTearDown(plan.dispose);
      expect(plan.preview['assetRef'], plan.parameters.sourceImageId);
      expect(plan.preview['maskAssetRef'], plan.parameters.maskImageId);
      final mask = await assets.read(plan.parameters.maskImageId!);
      expect((await images.pixel(mask, 20, 20)).take(3), [255, 255, 255]);
      expect((await images.pixel(mask, 2, 2)).take(3), [0, 0, 0]);
      final output = await assets.save(await images.solid(0xffe05040));
      final raw = images.result(output.assetRef, plan.parameters);
      final composed = await plan.processResult!(raw, () => true);
      expect(
        (await images.pixel(
          await assets.read(composed.assetRef!),
          2,
          2,
        )).take(3),
        [32, 64, 128],
      );
      expect(
        (await images.pixel(
          await assets.read(composed.assetRef!),
          20,
          20,
        )).take(3),
        [224, 80, 64],
      );
      final layer = await assets.read(
        composed.editMetadata!['layerAssetRef'] as String,
      );
      expect((await images.pixel(layer, 2, 2)).last, 0);
      expect((await images.pixel(layer, 20, 20)).last, 255);
      expect(composed.editMetadata!['responseAssetRef'], raw.assetRef);
      expect(c.imageEditing['candidates'], hasLength(1));
      expect(c.refillRevision, 1);
    },
  );
  test('received old result never replaces a changed canvas source', () async {
    final plan = await prepare();
    addTearDown(plan.dispose);
    final newSource = await assets.save(await images.solid(0xff20b080));
    editing.setSource(newSource);
    final changed = c.imageEditing;
    final output = await assets.save(await images.solid(0xffe05040));
    final composed = await plan.processResult!(
      images.result(output.assetRef, plan.parameters),
      () => true,
    );
    expect(c.imageEditing, changed);
    expect(composed.editMetadata!['parentAssetRef'], isNot(newSource.assetRef));
  });
  test('detached result keeps a deleted candidate removed and preserves live primary selection', () async {
    Future<void> addCandidate(String id, int color) async {
      final output = await assets.save(await images.solid(color));
      final frozen = await editing.prepare(64, 64);
      final raw = SceneResult(
        id: id,
        title: id,
        prompt: c.parameters.prompt,
        negative: c.parameters.negativePrompt ?? '',
        width: 64,
        height: 64,
        seed: 0,
        variant: 0,
        favorite: false,
        isDemo: false,
        assetRef: output.assetRef,
        parameters: c.parameters,
      );
      await editing.acceptResult(raw, frozen, () => true);
    }

    await addCandidate('candidate-to-delete', 0xffc05040);
    await addCandidate('candidate-to-keep', 0xff40a060);
    editing.choosePrimary('candidate-to-delete');
    final plan = await prepare();
    addTearDown(plan.dispose);

    // Candidate edits are output state, so they do not invalidate the
    // frozen generation input. The detached session must merge only its new
    // candidate into the current workspace state.
    editing.removeCandidate('candidate-to-delete');
    editing.choosePrimary('candidate-to-keep');
    final beforeRefill = c.refillRevision;
    final output = await assets.save(await images.solid(0xffe05040));
    final raw = images.result(output.assetRef, plan.parameters);

    await plan.processResult!(raw, () => true);

    final live = c.imageEditing;
    final candidateIds = [
      for (final value in live['candidates'] as List)
        (value as Map)['raw']['id'] as String,
    ];
    expect(candidateIds, ['candidate-to-keep', raw.id]);
    expect(candidateIds, isNot(contains('candidate-to-delete')));
    expect(live['primaryId'], 'candidate-to-keep');
    expect(c.refillRevision, beforeRefill + 1);
  });
  test('editing inputs change approval fingerprint, candidates do not', () {
    final before = c.assistantDraftFingerprint;
    c.updateImageEditing({...c.imageEditing, 'primaryId': 'output-selection'});
    expect(c.assistantDraftFingerprint, before);
    editing.clearMask();
    expect(c.assistantDraftFingerprint, isNot(before));
  });
  test('no mask and changed crop are rejected before any request', () async {
    editing.clearMask();
    await expectLater(prepare(), throwsA(isA<AgentException>()));
    final source = editing.document!.sourceAssetRef;
    c.updateAdvanced(
      c.parameters.copyWith(
        operation: GenerationOperation.imageToImage,
        img2imgSourceImageId: source,
        clearSourceImageId: true,
        clearMaskImageId: true,
      ),
    );
    editing.setImg2img({
      'originalAssetRef': source,
      'preparedAssetRef': source,
      'originalWidth': 64,
      'originalHeight': 64,
      'targetWidth': 128,
      'targetHeight': 64,
      'crop': [0, 0, 64, 64],
    });
    await expectLater(prepare(), throwsA(isA<AgentException>()));
  });
}
