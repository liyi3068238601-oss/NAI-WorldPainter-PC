import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  group('WorkbenchController prototype state', () {
    test('starts with three selectable demo scenes', () {
      final controller = WorkbenchController();
      addTearDown(controller.dispose);

      expect(controller.model, 'NAI Diffusion 4.5 Full');
      expect(controller.provider, 'NovelAI 官方');
      expect(controller.width, 832);
      expect(controller.height, 1216);
      expect(controller.steps, 28);
      expect(controller.cfg, 5.0);
      expect(controller.seedText, isEmpty);
      expect(controller.results.map((result) => result.title), [
        '月下远山',
        '晴岚山谷',
        '落日海岸',
      ]);
      expect(controller.results.every((result) => result.isDemo), isTrue);
      expect(controller.selected.id, controller.results.first.id);
      expect(controller.selected.model, 'NAI Diffusion 4.5 Full');
      expect(controller.selected.provider, 'NovelAI 官方');
      expect(controller.selected.steps, 28);
      expect(controller.selected.cfg, 5.0);
    });

    test('freezes submitted prompt and output settings and ignores duplicate submit', () async {
      final controller = WorkbenchController(
        generationDelay: const Duration(milliseconds: 90),
      );
      addTearDown(controller.dispose);
      controller
        ..updatePrompt('blue hour, cedar forest, quiet lake')
        ..updateNegative('text, logo')
        ..setSize(1024, 768)
        ..updateSeed('214748')
        ..updateModel('NAI Diffusion 4.5 Curated')
        ..updateProvider('演示网关')
        ..updateSteps(31.6)
        ..updateCfg(6.25);

      final initialCount = controller.results.length;
      final submitted = controller.generate();
      expect(controller.generating, isTrue);
      expect(controller.generate(), same(submitted));

      controller
        ..updatePrompt('later draft')
        ..updateNegative('later exclusion')
        ..setSize(512, 512)
        ..updateSeed('999')
        ..updateModel('later model')
        ..updateProvider('later provider')
        ..updateSteps(18)
        ..updateCfg(3.0);

      await submitted;

      expect(controller.results, hasLength(initialCount + 1));
      final result = controller.results.first;
      expect(result.prompt, 'blue hour, cedar forest, quiet lake');
      expect(result.negative, 'text, logo');
      expect(result.width, 1024);
      expect(result.height, 768);
      expect(result.seed, 214748);
      expect(result.isDemo, isTrue);
      expect(result.model, 'NAI Diffusion 4.5 Curated');
      expect(result.provider, '演示网关');
      expect(result.steps, 32);
      expect(result.cfg, 6.25);
      expect(controller.prompt, 'later draft');
      expect(controller.width, 512);
      expect(controller.generating, isFalse);
      expect(controller.status, contains('未调用生图服务'));

      controller.toggleFavorite(result.id);
      final favorite = controller.results.first;
      expect(favorite.favorite, isTrue);
      expect(favorite.model, result.model);
      expect(favorite.provider, result.provider);
      expect(favorite.steps, result.steps);
      expect(favorite.cfg, result.cfg);

      controller.applyResult(favorite);
      expect(controller.prompt, result.prompt);
      expect(controller.negative, result.negative);
      expect(controller.width, result.width);
      expect(controller.height, result.height);
      expect(controller.seedText, '214748');
      expect(controller.model, 'NAI Diffusion 4.5 Curated');
      expect(controller.provider, '演示网关');
      expect(controller.steps, 32);
      expect(controller.cfg, 6.25);

      controller
        ..updatePrompt('prompt-only draft')
        ..updateNegative('prompt-only negative')
        ..setSize(640, 640)
        ..updateSeed('77')
        ..updateModel('prompt-only model')
        ..updateProvider('prompt-only provider')
        ..updateSteps(16)
        ..updateCfg(2.75);
      controller.applyResult(favorite, promptOnly: true);
      expect(controller.prompt, result.prompt);
      expect(controller.negative, 'prompt-only negative');
      expect(controller.width, 640);
      expect(controller.height, 640);
      expect(controller.seedText, '77');
      expect(controller.model, 'prompt-only model');
      expect(controller.provider, 'prompt-only provider');
      expect(controller.steps, 16);
      expect(controller.cfg, 2.75);
    });

    test('cancellation in the final phase prevents commit and a later run can complete', () async {
      final controller = WorkbenchController(
        generationDelay: const Duration(milliseconds: 60),
      );
      addTearDown(controller.dispose);
      controller.updatePrompt('cancel this draft');
      var cancelledAtFinalPhase = false;
      void cancelAtFinalPhase() {
        if (!cancelledAtFinalPhase && controller.status == '正在整理演示结果') {
          cancelledAtFinalPhase = true;
          controller.cancelGeneration();
        }
      }

      controller.addListener(cancelAtFinalPhase);
      final cancelledRun = controller.generate();
      final initialCount = controller.results.length;
      await cancelledRun;
      controller.removeListener(cancelAtFinalPhase);

      expect(cancelledAtFinalPhase, isTrue);
      expect(controller.results, hasLength(initialCount));
      expect(controller.generating, isFalse);
      expect(controller.status, '演示任务已取消');

      controller.updatePrompt('keep this draft');
      await controller.generate();
      expect(controller.results, hasLength(initialCount + 1));
      expect(controller.results.first.prompt, 'keep this draft');
    });

    test('result selection, full parameter refill, prompt-only refill, and favorite are coherent', () {
      final controller = WorkbenchController();
      addTearDown(controller.dispose);
      final original = controller.results[1];

      controller.selectResult(original.id);
      controller.toggleFavorite(original.id);
      expect(controller.selected.favorite, isTrue);
      expect(original.favorite, isFalse);

      controller.applyResult(controller.selected);
      expect(controller.prompt, original.prompt);
      expect(controller.negative, original.negative);
      expect(controller.width, original.width);
      expect(controller.height, original.height);
      expect(controller.seedText, isEmpty); // Demo seed 0 means unavailable.

      controller
        ..updatePrompt('current prompt')
        ..updateNegative('keep this negative')
        ..setSize(640, 640)
        ..updateSeed('77');
      controller.applyResult(controller.results[2], promptOnly: true);

      expect(controller.prompt, controller.results[2].prompt);
      expect(controller.negative, 'keep this negative');
      expect(controller.width, 640);
      expect(controller.height, 640);
      expect(controller.seedText, '77');
    });

    test(
      'dispose interrupts simulation without notifying disposed listeners',
      () async {
        final controller = WorkbenchController(
          generationDelay: const Duration(seconds: 1),
        );
        var notifications = 0;
        controller.addListener(() => notifications++);
        final initialCount = controller.results.length;
        final pendingRun = controller.generate();
        notifications = 0;

        controller.dispose();
        await pendingRun;

        expect(notifications, 0);
        expect(controller.results, hasLength(initialCount));
        expect(controller.generating, isFalse);
      },
    );
  });
}
