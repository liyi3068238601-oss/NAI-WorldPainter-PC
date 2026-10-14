import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/wd_tagger.dart';

void main() {
  test(
    'real loopback HTTP uploads, submits, and reads the complete SSE event',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final root = 'http://127.0.0.1:${server.port}';
      final paths = <String>[];
      final errors = <Object>[];

      Future<void> handle(HttpRequest request) async {
        try {
          paths.add(request.uri.path);
          expect(request.connectionInfo!.remoteAddress.isLoopback, isTrue);
          expect(request.headers.value('authorization'), isNull);

          switch (request.uri.path) {
            case '/gradio_api/upload':
              expect(request.method, 'POST');
              expect(
                request.headers.contentType!.mimeType,
                'multipart/form-data',
              );
              final bytes = await request.fold<List<int>>(
                <int>[],
                (result, chunk) => result..addAll(chunk),
              );
              final multipart = latin1.decode(bytes);
              expect(multipart, contains('name="files"; filename="image.png"'));
              expect(
                multipart.toLowerCase(),
                contains('content-type: image/png'),
              );
              expect(multipart, contains(latin1.decode(_pngBytes)));

              request.response.headers.contentType = ContentType.json;
              request.response.write(jsonEncode(['tmp/loopback.png']));
              await request.response.close();
              return;
            case '/gradio_api/call/predict':
              expect(request.method, 'POST');
              expect(request.headers.contentType!.mimeType, 'application/json');
              final body =
                  jsonDecode(await utf8.decoder.bind(request).join()) as Map;
              final data = (body['data'] as List).cast<Object?>();
              expect(data, hasLength(6));
              expect(data[0], {
                'path': 'tmp/loopback.png',
                'url': '$root/gradio_api/file=tmp/loopback.png',
                'orig_name': 'image.png',
                'mime_type': 'image/png',
                'meta': {'_type': 'gradio.FileData'},
              });
              expect(data.sublist(1), [
                'SmilingWolf/wd-swinv2-tagger-v3',
                0.35,
                false,
                0.85,
                false,
              ]);

              request.response.headers.contentType = ContentType.json;
              request.response.write(
                jsonEncode({'event_id': 'loopback-event'}),
              );
              await request.response.close();
              return;
            case '/gradio_api/call/predict/loopback-event':
              expect(request.method, 'GET');
              expect(request.headers.value('accept'), 'text/event-stream');
              request.response.headers.contentType = ContentType(
                'text',
                'event-stream',
                charset: 'utf-8',
              );
              request.response.write(
                'event: generating\ndata: ["working"]\n\n',
              );
              request.response.write(
                'event: complete\ndata: ${jsonEncode(_validOutput())}\n\n',
              );
              await request.response.close();
              return;
            default:
              fail('Unexpected path ${request.uri.path}');
          }
        } catch (error) {
          errors.add(error);
          try {
            request.response.statusCode = HttpStatus.internalServerError;
            await request.response.close();
          } catch (_) {
            // The handler failure is asserted by the test; the response may
            // already have been closed when a later assertion failed.
          }
        }
      }

      final subscription = server.listen(
        (request) => unawaited(handle(request)),
      );
      try {
        final result = await HttpOverrides.runWithHttpOverrides(
          () => WdTaggerClient().analyze(
            bytes: _pngBytes,
            settings: WdTaggerSettings(enabled: true, baseUrl: root),
            cancellation: AgentCancellation(),
          ),
          _RealHttp(),
        );

        expect(errors, isEmpty);
        expect(paths, [
          '/gradio_api/upload',
          '/gradio_api/call/predict',
          '/gradio_api/call/predict/loopback-event',
        ]);
        expect(result.caption, '1girl, blue eyes');
        expect(result.generalTags, {'1girl': 0.99, 'blue eyes': 0.76});
        expect(result.characterTags, {'sample character': 0.88});
        expect(result.ratingTags, {'safe': 0.91, 'questionable': 0.07});
      } finally {
        await subscription.cancel();
        await server.close(force: true);
      }
    },
  );
}

class _RealHttp extends HttpOverrides {}

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
