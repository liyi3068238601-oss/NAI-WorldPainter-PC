import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/prototype/parameter_number_field.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  testWidgets(
    'advanced numeric editor follows external refill and validates input',
    (tester) async {
      num value = .15;
      late StateSetter rebuild;
      await tester.pumpWidget(
        MaterialApp(
          home: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return Scaffold(
                body: Form(
                  child: ParameterNumberField(
                    label: 'Rescale',
                    value: value,
                    max: 1,
                    onChanged: (v) => setState(() => value = v),
                  ),
                ),
              );
            },
          ),
        ),
      );
      await tester.enterText(find.byType(TextFormField), '.25');
      expect(value, .25);
      rebuild(() => value = .8);
      await tester.pump();
      expect(
        tester
            .widget<TextFormField>(find.byType(TextFormField))
            .controller!
            .text,
        '0.8',
      );
      await tester.enterText(find.byType(TextFormField), 'NaN');
      await tester.pump();
      expect(value, .8);
      expect(find.text('请输入 0–1'), findsOneWidget);
    },
  );

  testWidgets(
    'real generation UI has channel settings, editable advanced parameters and characters',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final c = WorkbenchController(
        generateImage: (_, _) async => throw const FormatException('测试停止'),
      );
      await tester.pumpWidget(WorldPainterApp(controller: c));
      await tester.pumpAndSettle();
      expect(find.text('生成 1 张图片'), findsOneWidget);
      await tester.tap(find.widgetWithText(ChoiceChip, '角色'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('添加角色'));
      await tester.tap(find.text('添加角色'));
      await tester.pumpAndSettle();
      expect(c.parameters.characters, hasLength(1));
      await tester.enterText(
        find.widgetWithText(TextFormField, '角色描述'),
        'Aster, blue coat',
      );
      await tester.pump();
      expect(c.parameters.characters.single.prompt, 'Aster, blue coat');
      expect(tester.takeException(), isNull);
    },
  );
}
