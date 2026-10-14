import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/wd_tagger.dart';

void main() {
  group('WdTaggerSettings', () {
    test('defaults disabled and round-trips model and thresholds', () {
      const settings = WdTaggerSettings();
      expect(settings.enabled, isFalse);
      expect(settings.model, 'SmilingWolf/wd-swinv2-tagger-v3');
      expect(WdTaggerSettings.models, hasLength(6));
      expect(settings.toJson()['schema'], 1);
      expect(
        WdTaggerSettings.fromJson(settings.toJson()).toJson(),
        settings.toJson(),
      );

      final enabled = settings.copyWith(
        enabled: true,
        model: 'SmilingWolf/wd-v1-4-moat-tagger-v2',
        generalThreshold: 0.4,
        characterThreshold: 0.9,
        generalMcut: true,
      );
      enabled.validate();
      expect(enabled.enabled, isTrue);
      expect(enabled.generalMcut, isTrue);
      expect(WdTaggerSettings.fromJson(enabled.toJson()).model, enabled.model);
    });

    test('rejects unknown or incorrectly typed JSON fields', () {
      expect(
        () => WdTaggerSettings.fromJson({'enabled': 'true'}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => WdTaggerSettings.fromJson({'unexpected': 1}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => WdTaggerSettings.fromJson({}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => WdTaggerSettings.fromJson({
          ...WdTaggerSettings().toJson(),
          'schema': 2,
        }),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => WdTaggerSettings.fromJson({'generalThreshold': double.nan}),
        throwsA(isA<FormatException>()),
      );
    });

    test('accepts only HTTPS or loopback HTTP service roots', () {
      expect(
        normalizeWdTaggerBaseUrl('https://tags.example/root///'),
        'https://tags.example/root',
      );
      expect(
        normalizeWdTaggerBaseUrl('http://localhost:7860'),
        'http://localhost:7860',
      );
      expect(
        normalizeWdTaggerBaseUrl('http://127.0.0.2:7860'),
        'http://127.0.0.2:7860',
      );
      expect(
        normalizeWdTaggerBaseUrl('http://[::1]:7860'),
        'http://[::1]:7860',
      );
      for (final value in [
        'https://user:secret@tags.example',
        'https://tags.example?token=secret',
        'https://tags.example/#fragment',
        'http://192.168.1.20:7860',
        'http://localhost.example:7860',
        'ftp://tags.example',
      ]) {
        expect(
          () => normalizeWdTaggerBaseUrl(value),
          throwsA(isA<AgentException>()),
          reason: value,
        );
      }
    });
  });

  group('WdTaggerClient', () {
    test('uploads synthetic PNG and parses only the complete event', () async {
      final client = _RecordingClient((request, body, index) async {
        switch (index) {
          case 0:
            return _jsonResponse(['tmp/upload-123.png']);
          case 1:
            return _jsonResponse({'event_id': 'event_123'});
          case 2:
            return _textResponse(
              'event: generating\n'
              'data: ["progress"]\n\n'
              'event: complete\n'
              'data: ${jsonEncode(_validOutput())}\n\n',
              contentType: 'text/event-stream; charset=utf-8',
            );
          default:
            throw StateError('Unexpected request');
        }
      });

      final result = await WdTaggerClient(clientFactory: () => client).analyze(
        bytes: _pngBytes,
        settings: const WdTaggerSettings(enabled: true),
        cancellation: AgentCancellation(),
      );

      expect(client.requests, hasLength(3));
      final upload = client.requests[0];
      expect(upload.request, isA<http.MultipartRequest>());
      expect(upload.request.url.path, '/gradio_api/upload');
      expect(upload.request.followRedirects, isFalse);
      expect(upload.request.maxRedirects, 0);
      final multipart = upload.request as http.MultipartRequest;
      expect(multipart.files, hasLength(1));
      expect(multipart.files.single.field, 'files');
      expect(multipart.files.single.filename, 'image.png');
      expect(multipart.files.single.contentType.toString(), 'image/png');
      expect(latin1.decode(upload.body), contains('filename="image.png"'));
      expect(
        latin1.decode(upload.body).toLowerCase(),
        contains('content-type: image/png'),
      );
      expect(upload.request.headers.keys, isNot(contains('authorization')));

      final submit = client.requests[1];
      expect(submit.request.url.path, '/gradio_api/call/predict');
      expect(submit.request.followRedirects, isFalse);
      expect(submit.request.maxRedirects, 0);
      final submitJson = jsonDecode(utf8.decode(submit.body)) as Map;
      final data = submitJson['data'] as List;
      expect(data, hasLength(6));
      expect(data[0], {
        'path': 'tmp/upload-123.png',
        'url': 'https://smilingwolf-wd-tagger.hf.space/gradio_api/file=tmp/upload-123.png',
        'orig_name': 'image.png',
        'mime_type': 'image/png',
        'meta': {'_type': 'gradio.FileData'},
      });
      expect(data[1], defaultWdTaggerModel);
      expect(data.sublist(2), [0.35, false, 0.85, false]);
      expect(submit.request.headers.keys, isNot(contains('authorization')));

      final poll = client.requests[2];
      expect(poll.request.method, 'GET');
      expect(poll.request.url.path, '/gradio_api/call/predict/event_123');
      expect(poll.request.headers['accept'], 'text/event-stream');
      expect(poll.request.followRedirects, isFalse);
      expect(poll.request.maxRedirects, 0);
      expect(client.isClosed, isTrue);

      expect(result.caption, '1girl, blue eyes');
      expect(result.ratingTags, {'safe': 0.91, 'questionable': 0.07});
      expect(result.characterTags, {'sample character': 0.88});
      expect(result.generalTags, {'1girl': 0.99, 'blue eyes': 0.76});
      expect(result.toJson(), {
        'caption': '1girl, blue eyes',
        'generalTags': {'1girl': 0.99, 'blue eyes': 0.76},
        'characterTags': {'sample character': 0.88},
        'ratingTags': {'safe': 0.91, 'questionable': 0.07},
      });
      expect(() => result.generalTags['new tag'] = 1, throwsUnsupportedError);
    });

    test(
      'does not create a client when disabled or input is not PNG',
      () async {
        var createdClients = 0;
        final wdClient = WdTaggerClient(
          clientFactory: () {
            createdClients++;
            return _RecordingClient((_, _, _) async => _jsonResponse([]));
          },
        );

        await expectLater(
          wdClient.analyze(
            bytes: _pngBytes,
            settings: const WdTaggerSettings(),
            cancellation: AgentCancellation(),
          ),
          throwsA(isA<AgentException>()),
        );
        await expectLater(
          wdClient.analyze(
            bytes: Uint8List.fromList([1, 2, 3, 4, 5, 6, 7, 8]),
            settings: const WdTaggerSettings(enabled: true),
            cancellation: AgentCancellation(),
          ),
          throwsA(isA<AgentException>()),
        );
        expect(createdClients, 0);
      },
    );

    test('rejects input above 10 MiB before creating a client', () async {
      var createdClients = 0;
      final tooLarge = Uint8List(_maxTestUploadBytes + 1)
        ..setRange(0, _pngBytes.length, _pngBytes);
      final wdClient = WdTaggerClient(
        clientFactory: () {
          createdClients++;
          return _RecordingClient((_, _, _) async => _jsonResponse([]));
        },
      );

      await expectLater(
        wdClient.analyze(
          bytes: tooLarge,
          settings: const WdTaggerSettings(enabled: true),
          cancellation: AgentCancellation(),
        ),
        throwsA(isA<AgentException>()),
      );
      expect(createdClients, 0);
    });

    test('rejects redirects at upload, submit, and SSE stages', () async {
      for (var redirectAt = 0; redirectAt < 3; redirectAt++) {
        final client = _RecordingClient((_, _, index) async {
          if (index == redirectAt) {
            return _textResponse(
              'redirect body must not be surfaced',
              statusCode: 302,
              headers: {'location': 'https://other.example'},
            );
          }
          return switch (index) {
            0 => _jsonResponse(['tmp/file.png']),
            1 => _jsonResponse({'event_id': 'abc'}),
            2 => _textResponse(
              'event: complete\ndata: ${jsonEncode(_validOutput())}\n\n',
              contentType: 'text/event-stream',
            ),
            _ => throw StateError('Unexpected request'),
          };
        });

        await expectLater(
          WdTaggerClient(clientFactory: () => client).analyze(
            bytes: _pngBytes,
            settings: const WdTaggerSettings(enabled: true),
            cancellation: AgentCancellation(),
          ),
          throwsA(
            isA<AgentException>().having(
              (error) => error.message,
              'message',
              contains('重定向'),
            ),
          ),
        );
        expect(client.requests, hasLength(redirectAt + 1));
        expect(client.isClosed, isTrue);
      }
    });

    test('keeps safe HTTP status errors and does not retry', () async {
      final client = _RecordingClient(
        (_, _, _) async => _textResponse('private error body', statusCode: 503),
      );

      try {
        await _analyze(client);
        fail('Expected HTTP 503 to fail.');
      } on AgentException catch (error) {
        expect(error.message, contains('HTTP 503'));
        expect(error.message, isNot(contains('private error body')));
      }
      expect(client.requests, hasLength(1));
    });

    test('does not treat generating data as a successful result', () async {
      final client = _threeStepClient(
        _textResponse(
          'event: generating\ndata: ${jsonEncode(_validOutput())}\n\n',
          contentType: 'text/event-stream',
        ),
      );

      await expectLater(_analyze(client), throwsA(isA<AgentException>()));
      expect(client.isClosed, isTrue);
    });

    test(
      'does not expose error event text or malformed response bodies',
      () async {
        final errorClient = _threeStepClient(
          _textResponse(
            'event: error\ndata: "private backend detail"\n\n',
            contentType: 'text/event-stream',
          ),
        );
        try {
          await _analyze(errorClient);
          fail('Expected an error event to fail.');
        } on AgentException catch (error) {
          expect(error.message, isNot(contains('private backend detail')));
        }

        final malformedClient = _threeStepClient(
          _textResponse(
            'event: complete\ndata: {broken json}\n\n',
            contentType: 'text/event-stream',
          ),
        );
        await expectLater(
          _analyze(malformedClient),
          throwsA(isA<AgentException>()),
        );
      },
    );

    test('bounds response bytes, caption bytes, and tag counts', () async {
      final oversizedResponseClient = _RecordingClient((_, _, index) async {
        if (index == 0) {
          return http.StreamedResponse(
            Stream<List<int>>.value(
              List<int>.filled(_maxTestResponseBytes + 1, 120),
            ),
            200,
          );
        }
        throw StateError('Unexpected request');
      });
      await expectLater(
        _analyze(oversizedResponseClient),
        throwsA(isA<AgentException>()),
      );
      expect(oversizedResponseClient.requests, hasLength(1));

      final longCaptionOutput = _validOutput()..[0] = 'c' * (16 * 1024 + 1);
      await expectLater(
        _analyze(
          _threeStepClient(
            _textResponse(
              'event: complete\ndata: ${jsonEncode(longCaptionOutput)}\n\n',
              contentType: 'text/event-stream',
            ),
          ),
        ),
        throwsA(isA<AgentException>()),
      );

      final tooManyGeneralTags = [
        for (var index = 0; index < 1001; index++)
          {'label': 'tag $index', 'confidence': 0.5},
      ];
      final tooManyOutput = _validOutput()
        ..[3] = {'label': 'tag 0', 'confidences': tooManyGeneralTags};
      await expectLater(
        _analyze(
          _threeStepClient(
            _textResponse(
              'event: complete\ndata: ${jsonEncode(tooManyOutput)}\n\n',
              contentType: 'text/event-stream',
            ),
          ),
        ),
        throwsA(isA<AgentException>()),
      );
    });

    test('uses one total timeout and closes the owned client', () async {
      final sseStream = StreamController<List<int>>();
      final client = _RecordingClient((request, body, index) async {
        switch (index) {
          case 0:
            return _jsonResponse(['tmp/slow.png']);
          case 1:
            return _jsonResponse({'event_id': 'slow'});
          case 2:
            return http.StreamedResponse(
              sseStream.stream,
              200,
              headers: {'content-type': 'text/event-stream'},
            );
          default:
            throw StateError('Unexpected request');
        }
      });

      try {
        await expectLater(
          WdTaggerClient(
            clientFactory: () => client,
            timeout: const Duration(milliseconds: 20),
          ).analyze(
            bytes: _pngBytes,
            settings: const WdTaggerSettings(enabled: true),
            cancellation: AgentCancellation(),
          ),
          throwsA(
            isA<AgentException>().having(
              (error) => error.message,
              'message',
              contains('超时'),
            ),
          ),
        );
        expect(client.requests, hasLength(3));
        expect(client.isClosed, isTrue);
      } finally {
        await sseStream.close();
      }
    });

    test(
      'a late upload after timeout cannot start submit or cancel caller',
      () async {
        final client = _LateUploadClient();
        final callerCancellation = AgentCancellation();
        final request =
            WdTaggerClient(
              clientFactory: () => client,
              timeout: const Duration(milliseconds: 20),
            ).analyze(
              bytes: _pngBytes,
              settings: const WdTaggerSettings(enabled: true),
              cancellation: callerCancellation,
            );

        await client.started.future;
        await expectLater(request, throwsA(isA<AgentException>()));
        expect(client.isClosed, isTrue);
        expect(callerCancellation.isCancelled, isFalse);

        client.uploadResponse.complete(_jsonResponse(['tmp/late.png']));
        await Future<void>.delayed(Duration.zero);
        expect(client.requestCount, 1);
        expect(callerCancellation.isCancelled, isFalse);
      },
    );

    test('cancellation remains AgentCancelled and closes the client', () async {
      final client = _PendingClient();
      final cancellation = AgentCancellation();
      final request = WdTaggerClient(clientFactory: () => client).analyze(
        bytes: _pngBytes,
        settings: const WdTaggerSettings(enabled: true),
        cancellation: cancellation,
      );

      await client.started.future;
      cancellation.cancel();

      await expectLater(request, throwsA(isA<AgentCancelled>()));
      expect(client.isClosed, isTrue);
    });
  });
}

const _maxTestUploadBytes = 10 * 1024 * 1024;
const _maxTestResponseBytes = 1024 * 1024;
final Uint8List _pngBytes = Uint8List.fromList([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  1,
  2,
  3,
]);

List<Object?> _validOutput() => [
  '1girl, blue eyes',
  {
    'label': 'safe',
    'confidences': [
      {'label': 'safe', 'confidence': 0.91},
      {'label': 'questionable', 'confidence': 0.07},
    ],
  },
  {
    'label': 'sample character',
    'confidences': [
      {'label': 'sample character', 'confidence': 0.88},
    ],
  },
  {
    'label': '1girl',
    'confidences': [
      {'label': '1girl', 'confidence': 0.99},
      {'label': 'blue eyes', 'confidence': 0.76},
    ],
  },
];

WdTaggerClient _clientWith(http.Client client) =>
    WdTaggerClient(clientFactory: () => client);

Future<WdTaggerResult> _analyze(_RecordingClient client) =>
    _clientWith(client).analyze(
      bytes: _pngBytes,
      settings: const WdTaggerSettings(enabled: true),
      cancellation: AgentCancellation(),
    );

_RecordingClient _threeStepClient(http.StreamedResponse sse) =>
    _RecordingClient((_, _, index) async {
      switch (index) {
        case 0:
          return _jsonResponse(['tmp/file.png']);
        case 1:
          return _jsonResponse({'event_id': 'event-1'});
        case 2:
          return sse;
        default:
          throw StateError('Unexpected request');
      }
    });

http.StreamedResponse _jsonResponse(Object body, {int statusCode = 200}) =>
    _textResponse(
      jsonEncode(body),
      statusCode: statusCode,
      contentType: 'application/json; charset=utf-8',
    );

http.StreamedResponse _textResponse(
  String body, {
  int statusCode = 200,
  String? contentType,
  Map<String, String> headers = const {},
}) {
  final bytes = utf8.encode(body);
  return http.StreamedResponse(
    Stream<List<int>>.value(bytes),
    statusCode,
    headers: {'content-type': contentType ?? 'text/plain', ...headers},
    contentLength: bytes.length,
  );
}

typedef _ResponseHandler = Future<http.StreamedResponse> Function(
  http.BaseRequest request,
  List<int> body,
  int index,
);

class _RecordedRequest {
  const _RecordedRequest(this.request, this.body);

  final http.BaseRequest request;
  final List<int> body;
}

class _RecordingClient extends http.BaseClient {
  _RecordingClient(this._handler);

  final _ResponseHandler _handler;
  final requests = <_RecordedRequest>[];
  bool isClosed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final body = await request.finalize().toBytes();
    final index = requests.length;
    requests.add(_RecordedRequest(request, body));
    return _handler(request, body, index);
  }

  @override
  void close() {
    isClosed = true;
  }
}

class _PendingClient extends http.BaseClient {
  final started = Completer<void>();
  bool isClosed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (!started.isCompleted) started.complete();
    return Completer<http.StreamedResponse>().future;
  }

  @override
  void close() {
    isClosed = true;
  }
}

class _LateUploadClient extends http.BaseClient {
  final started = Completer<void>();
  final uploadResponse = Completer<http.StreamedResponse>();
  var requestCount = 0;
  var isClosed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    await request.finalize().toBytes();
    requestCount++;
    if (!started.isCompleted) started.complete();
    return uploadResponse.future;
  }

  @override
  void close() {
    isClosed = true;
  }
}
