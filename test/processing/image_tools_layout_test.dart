import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/processing/postprocess_parameters.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/workspace_store.dart';

void main() {
  group('image tools layout and default parameters', () {
    testWidgets(
      'fits desktop and compact viewports and keeps compact controls reachable',
      (tester) async {
        addTearDown(() => _resetViewport(tester));
        const viewports = [Size(1440, 900), Size(1280, 720), Size(640, 480)];

        for (final viewport in viewports) {
          _setViewport(tester, viewport);
          await tester.pumpWidget(
            WorldPainterApp(controller: _restoredController()),
          );
          await tester.pumpAndSettle();

          expect(
            tester.takeException(),
            isNull,
            reason:
                'Image tools should fit ${viewport.width}×${viewport.height}.',
          );

          if (viewport.width == 640) {
            final openParameters = find.byTooltip('打开图片工具参数');
            expect(openParameters.hitTestable(), findsOneWidget);
            await tester.tap(openParameters);
            await tester.pumpAndSettle();

            final submit = find.text('开始导演工具');
            expect(submit.hitTestable(), findsOneWidget);
            final rect = tester.getRect(submit);
            expect(rect.left, greaterThanOrEqualTo(0));
            expect(rect.top, greaterThanOrEqualTo(0));
            expect(rect.right, lessThanOrEqualTo(viewport.width));
            expect(rect.bottom, lessThanOrEqualTo(viewport.height));
            expect(tester.takeException(), isNull);
          }

          await tester.pumpWidget(const SizedBox.shrink());
        }
      },
    );

    testWidgets(
      'Director and Enhance defaults serialize and validate on submit',
      (tester) async {
        addTearDown(() => _resetViewport(tester));
        _setViewport(tester, const Size(1440, 900));
        final submitted = <Map<String, Object?>>[];
        final controller = _restoredController(
          processImageTool:
              (draft, parameters, connection, progress, isCurrent) async {
                final postprocess = Map<String, Object?>.from(
                  draft['postprocess']! as Map,
                );
                PostprocessParameters.fromJson(
                  Map<String, dynamic>.from(postprocess),
                ).validate();
                submitted.add(postprocess);
                return SceneResult(
                  id: 'fixture-${submitted.length}',
                  title: 'fixture',
                  prompt: parameters.prompt,
                  negative: parameters.negativePrompt ?? '',
                  width: 832,
                  height: 1216,
                  seed: 0,
                  variant: 0,
                  favorite: false,
                  isDemo: false,
                  parameters: parameters,
                );
              },
        );
        await tester.pumpWidget(WorldPainterApp(controller: controller));
        await tester.pumpAndSettle();

        await _submit(tester, '开始导演工具');
        expect(submitted, hasLength(1));
        expect(submitted[0]['director_tool'], 'declutter');
        expect(submitted[0]['defry'], isNull);

        await tester.tap(find.text('去杂物'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('线稿上色').last);
        await tester.pumpAndSettle();
        expect(find.text('导演 Defry'), findsOneWidget);
        await _submit(tester, '开始导演工具');
        expect(submitted, hasLength(2));
        expect(submitted[1]['director_tool'], 'colorize');
        expect(submitted[1]['defry'], 5);

        await tester.tap(find.text('导演工具').first);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Enhance 重绘增强').last);
        await tester.pumpAndSettle();
        await _submit(tester, '开始Enhance 重绘增强');

        expect(submitted, hasLength(3));
        expect(submitted[2]['scale'], 1.5);
        expect(submitted[2]['noise'], 0.1);
        expect(tester.takeException(), isNull);
      },
    );
  });
}

Future<void> _submit(WidgetTester tester, String label) async {
  final button = find.text(label);
  expect(button.hitTestable(), findsOneWidget);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

WorkbenchController _restoredController({ProcessImageTool? processImageTool}) {
  final source = WorkbenchController();
  source.setImageToolSource(
    const ImageAsset(
      id: 'fixture-source',
      assetRef: 'asset:fixture-source',
      width: 832,
      height: 1216,
      mime: 'image/png',
      sha256: 'fixture-source',
      byteLength: 1,
    ),
  );
  source.updateImageTools({
    ...source.imageTools,
    'mode': 'director',
    'active': true,
    'protocol': 'official',
  });
  final snapshot = source.exportWorkspace();
  source.dispose();
  return WorkbenchController(
    restored: StoredWorkspace(revision: 0, data: snapshot),
    processImageTool: processImageTool,
  );
}

void _setViewport(WidgetTester tester, Size logicalSize) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = logicalSize;
}

void _resetViewport(WidgetTester tester) {
  tester.view.resetPhysicalSize();
  tester.view.resetDevicePixelRatio();
}
