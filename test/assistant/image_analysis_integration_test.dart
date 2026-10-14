import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/wd_tagger.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  test(
    'legacy settings remain disabled; malformed settings reject restore',
    () {
      final state = AssistantState();
      final json = state.toJson()..remove('wdTagger');
      expect(AssistantState.fromJson(json).wdTagger.enabled, false);
      for (final bad in [
        null,
        {},
        {'enabled': 'yes'},
      ]) {
        expect(
          () => AssistantState.fromJson({...json, 'wdTagger': bad}),
          throwsFormatException,
        );
      }
    },
  );

  test(
    'WD only strips PNG text metadata, bounds observations, and reopens SQLite',
    () async {
      final wd = _Wd();
      final transport = _Transport();
      final h = await _harness(wd, transport);
      var c = h.controller;
      final source = await _png();
      await c.assistant.attachImage(source);
      final ref = c.assistant.session.attachments.single;
      c.assistant.updateWdTaggerSettings(const WdTaggerSettings(enabled: true));
      c.assistant.updateInput('分析合成图片');
      await c.assistant.send();
      final turn = c.assistant.session.turns.single;
      expect(turn.status, 'complete', reason: turn.error);
      expect(wd.received, hasLength(1));
      expect(
        latin1.decode(wd.received.single),
        isNot(contains('SYNTHETIC_PRIVATE_METADATA')),
      );
      expect(await c.assets!.read(ref), source);
      expect(transport.requests, hasLength(1));
      expect(
        jsonEncode(transport.requests.single),
        contains('synthetic_tag_0'),
      );
      expect(
        jsonEncode(transport.requests.single),
        isNot(contains('synthetic_tag_40')),
      );
      expect(c.assistant.status, contains('未调用工具'));
      expect(
        jsonEncode(c.assistant.state.toJson()),
        isNot(contains('data:image')),
      );
      expect(
        jsonEncode(c.assistant.state.toJson()),
        isNot(contains('SYNTHETIC_PRIVATE_METADATA')),
      );
      await c.flush();
      await c.closeStorage();
      c.dispose();
      final store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: h.path,
      );
      c = WorkbenchController(
        store: store,
        restored: await store.load(),
        assets: await openImageAssetStore(directory: h.dir.path),
        assistantTransport: transport,
        wdTaggerClient: wd,
      );
      try {
        expect(c.assistant.state.wdTagger.enabled, true);
        expect(
          c.assistant.session.turns.single.traces.single['status'],
          'completed',
        );
        c.assistant.updateInput('继续说明刚才的图片');
        await c.assistant.send();
        expect(wd.received, hasLength(1));
        expect(
          jsonEncode(transport.requests.last),
          contains('synthetic_tag_0'),
        );
        expect(c.assistant.session.turns.last.status, 'complete');
        await File('.tmp/assistant-images-native-fixture.json')
            .writeAsString(jsonEncode(c.exportWorkspace()));
        await File('.tmp/assistant-images-native-source.txt')
            .writeAsString(h.dir.absolute.path);
      } finally {
        await c.closeStorage();
        c.dispose();
      }
    },
  );

  test(
    'WD disabled never calls tag service; vision input is metadata-free',
    () async {
      final wd = _Wd();
      final t = _Transport();
      final h = await _harness(wd, t, vision: true);
      final c = h.controller;
      addTearDown(() async {
        await c.closeStorage();
        c.dispose();
      });
      await c.assistant.attachImage(await _png());
      c.assistant.updateInput('描述');
      await c.assistant.send();
      expect(wd.received, isEmpty);
      expect(c.assistant.session.turns.single.status, 'complete');
      final parts = t.requests.first.single['content'] as List;
      final url = (parts[1] as Map)['image_url']['url'] as String;
      expect(
        latin1.decode(base64Decode(url.split(',').last)),
        isNot(contains('SYNTHETIC_PRIVATE_METADATA')),
      );
      expect(
        jsonEncode(t.requests.last),
        contains('synthetic vision description'),
      );
    },
  );

  for (final visionFails in [false, true]) {
    test(
      'one analysis service fails; other complete source remains usable ($visionFails)',
      () async {
        final wd = _Wd(fail: !visionFails);
        final t = _Transport(visionFails: visionFails);
        final h = await _harness(wd, t, vision: true);
        final c = h.controller;
        addTearDown(() async {
          await c.closeStorage();
          c.dispose();
        });
        c.assistant.updateWdTaggerSettings(
          const WdTaggerSettings(enabled: true),
        );
        await c.assistant.attachImage(await _png());
        c.assistant.updateInput('描述');
        await c.assistant.send();
        final turn = c.assistant.session.turns.single;
        expect(turn.status, 'complete', reason: turn.error);
        expect(turn.traces.where((t) => t['status'] == 'failed'), hasLength(1));
        expect(c.assistant.status, contains('部分附图分析失败'));
        expect(
          jsonEncode(t.requests.last),
          contains(visionFails ? '识图描述失败' : 'WD-Tagger 分析失败'),
        );
        expect(
          jsonEncode(c.exportWorkspace()),
          isNot(contains('sensitive upstream body')),
        );
      },
    );
  }

  test(
    'missing analysis for any attachment stops main model rather than guessing',
    () async {
      final wd = _Wd(failAfter: 1);
      final t = _Transport();
      final h = await _harness(wd, t);
      final c = h.controller;
      addTearDown(() async {
        await c.closeStorage();
        c.dispose();
      });
      c.assistant.updateWdTaggerSettings(const WdTaggerSettings(enabled: true));
      await c.assistant.attachImage(await _png());
      await c.assistant.attachImage(await _png(color: 0xff223344));
      c.assistant.updateInput('比较两张图');
      await c.assistant.send();
      expect(c.assistant.session.turns.single.status, 'failed');
      expect(t.requests, isEmpty);
    },
  );

  test('cancel stops WD wait, prevents late main call, settings and session stay frozen', () async {
    final gate = Completer<WdTaggerResult>();
    final wd = _Wd(gate: gate);
    final t = _Transport();
    final h = await _harness(wd, t);
    final c = h.controller;
    addTearDown(() async {
      await c.closeStorage();
      c.dispose();
    });
    c.assistant.updateWdTaggerSettings(const WdTaggerSettings(enabled: true));
    await c.assistant.attachImage(await _png());
    c.assistant.updateInput('描述');
    final sending = c.assistant.send();
    await wd.started.future.timeout(const Duration(seconds: 5));
    expect(
      () => c.assistant.updateWdTaggerSettings(const WdTaggerSettings()),
      throwsA(isA<AgentException>()),
    );
    expect(() => c.assistant.newSession(), throwsA(isA<AgentException>()));
    c.assistant.cancel();
    await sending.timeout(const Duration(seconds: 5));
    gate.complete(_result());
    await Future<void>.delayed(Duration.zero);
    expect(c.assistant.session.turns.single.status, 'cancelled');
    expect(
      c.assistant.session.turns.single.traces.single['status'],
      'cancelled',
    );
    expect(t.requests, isEmpty);
  });

  test(
    'diagnostic remains isolated from attached images and WD settings',
    () async {
      final wd = _Wd(fail: true);
      final t = _Transport(diagnostic: true);
      final h = await _harness(wd, t);
      final c = h.controller;
      addTearDown(() async {
        await c.closeStorage();
        c.dispose();
      });
      c.assistant.updateWdTaggerSettings(const WdTaggerSettings(enabled: true));
      await c.assistant.attachImage(await _png());
      await c.assistant.send(diagnostic: true);
      expect(c.assistant.session.turns.single.status, 'complete');
      expect(c.assistant.session.attachments, hasLength(1));
      expect(wd.received, isEmpty);
      expect(t.tools.first.single['function']['name'], 'diagnostic_echo');
    },
  );
}

Future<({WorkbenchController controller, Directory dir, String path})> _harness(
  _Wd wd,
  _Transport transport, {
  bool vision = false,
}) async {
  final root = await Directory('.tmp/assistant-images-tests').absolute
      .create(recursive: true);
  final dir = await root.createTemp('case-');
  final path = '${dir.path}/workspace.sqlite';
  final store = await SQLiteWorkspaceStore.open(
    factory: databaseFactoryFfi,
    path: path,
  );
  final c = WorkbenchController(
    store: store,
    assets: await openImageAssetStore(directory: dir.path),
    assistantTransport: transport,
    wdTaggerClient: wd,
  );
  final a = c.assistant;
  a.state.providers.add(
    const AssistantProvider(
      id: 'main',
      name: '测试主模型',
      baseUrl: 'https://main.invalid/v1',
      model: 'synthetic',
      requireKey: false,
    ),
  );
  a.state.mainProviderId = 'main';
  if (vision) {
    a.state.providers.add(
      const AssistantProvider(
        id: 'vision',
        name: '测试识图',
        baseUrl: 'https://vision.invalid/v1',
        model: 'synthetic',
        requireKey: false,
      ),
    );
    a.state.visionProviderId = 'vision';
  }
  return (controller: c, dir: dir, path: path);
}

WdTaggerResult _result() => WdTaggerResult(
  caption: 'ignored raw caption',
  generalTags: {for (var i = 0; i < 50; i++) 'synthetic_tag_$i': 1 - i / 100},
  characterTags: {'synthetic_character': .9},
  ratingTags: {'general': .99},
);

class _Wd extends WdTaggerClient {
  _Wd({this.fail = false, this.failAfter, this.gate});
  final bool fail;
  final int? failAfter;
  final Completer<WdTaggerResult>? gate;
  final started = Completer<void>();
  final received = <Uint8List>[];
  @override
  Future<WdTaggerResult> analyze({
    required Uint8List bytes,
    required WdTaggerSettings settings,
    required AgentCancellation cancellation,
  }) async {
    received.add(bytes);
    if (!started.isCompleted) started.complete();
    if (gate != null) return gate!.future;
    if (fail || (failAfter != null && received.length > failAfter!)) {
      throw StateError('sensitive upstream body');
    }
    return _result();
  }
}

class _Transport implements AgentTransport {
  _Transport({this.visionFails = false, this.diagnostic = false});
  final bool visionFails, diagnostic;
  final requests = <List<Map<String, dynamic>>>[];
  final tools = <List<Map<String, dynamic>>>[];
  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String)? onText,
  }) async {
    requests.add(
      List<Map<String, dynamic>>.from(jsonDecode(jsonEncode(messages))),
    );
    this.tools.add(tools);
    if (provider.id == 'vision') {
      expect(tools, isEmpty);
      expect(toolChoice, 'none');
      if (visionFails) throw StateError('sensitive upstream body');
      return const AgentReply(content: 'synthetic vision description');
    }
    if (diagnostic && requests.length == 1) {
      final nonce = tools
          .single['function']['parameters']['properties']['value']['enum'][0];
      return AgentReply(
        calls: [
          AgentCall(
            id: 'diag',
            name: 'diagnostic_echo',
            arguments: jsonEncode({'value': nonce}),
          ),
        ],
      );
    }
    return const AgentReply(content: '合成测试：已依据附图分析。');
  }
}

Future<Uint8List> _png({int color = 0xffaabbcc}) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    const ui.Rect.fromLTWH(0, 0, 16, 16),
    ui.Paint()..color = ui.Color(color),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(16, 16);
  try {
    final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!
        .buffer
        .asUint8List();
    final payload = latin1.encode('tEXtComment\x00SYNTHETIC_PRIVATE_METADATA');
    var crc = 0xffffffff;
    for (final byte in payload) {
      crc ^= byte;
      for (var i = 0; i < 8; i++) {
        crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xedb88320 : crc >> 1;
      }
    }
    final length = ByteData(4)..setUint32(0, payload.length - 4);
    final checksum = ByteData(4)..setUint32(0, crc ^ 0xffffffff);
    return Uint8List.fromList([
      ...bytes.take(33),
      ...length.buffer.asUint8List(),
      ...payload,
      ...checksum.buffer.asUint8List(),
      ...bytes.skip(33),
    ]);
  } finally {
    image.dispose();
    picture.dispose();
  }
}
