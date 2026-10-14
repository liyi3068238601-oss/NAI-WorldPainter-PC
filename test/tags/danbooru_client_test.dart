import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/tags/danbooru_client.dart';

void main() {
  group('DanbooruSearchClient', () {
    test(
      'posts the bounded semantic-search request without credentials',
      () async {
        late http.Request sentRequest;
        final client = MockClient((request) async {
          sentRequest = request;
          return _jsonResponse({
            'results': [
              {
                'tag': 'white_serafuku',
                'cn_name': '白色水手服',
                'category': 'General',
                'nsfw': 'safe',
                'count': 1200,
                'final_score': 0.82,
                'wiki': 'A white sailor uniform.',
              },
            ],
            'api_key_notice': 'ignored envelope field',
          });
        });

        final result = await _client(client).search(
          query: '  白色水手服  ',
          cancellation: AgentCancellation(),
          baseUrl: 'https://tags.example/proxy///',
        );

        expect(
          sentRequest.url.toString(),
          'https://tags.example/proxy/api/search',
        );
        expect(sentRequest.followRedirects, isFalse);
        expect(sentRequest.maxRedirects, 0);
        expect(jsonDecode(sentRequest.body), {
          'query': '白色水手服',
          'top_k': 5,
          'limit': 30,
          'show_nsfw': true,
        });
        expect(
          sentRequest.headers.keys.map((key) => key.toLowerCase()),
          isNot(contains('authorization')),
        );
        expect(result.source, 'https://tags.example/proxy');
        expect(result.query, '白色水手服');
        expect(result.tags, hasLength(1));
        expect(result.tags.single.promptText, 'white serafuku');
        expect(result.tags.single.cnName, '白色水手服');
        expect(result.tags.single.count, 1200);
        expect(result.tags.single.score, 0.82);
        expect(result.tags.single.toJson()['final_score'], 0.82);
        expect(
          () => result.tags.add(const DanbooruTag(tag: 'extra')),
          throwsUnsupportedError,
        );
      },
    );

    test(
      'clamps the requested limit and bounds the returned tag count',
      () async {
        late http.Request sentRequest;
        final client = MockClient((request) async {
          sentRequest = request;
          return _jsonResponse({
            'results': [
              for (var index = 0; index < 40; index++) {'tag': 'tag_$index'},
            ],
          });
        });

        final result = await _client(client).search(
          query: 'character',
          cancellation: AgentCancellation(),
          limit: 500,
        );

        expect((jsonDecode(sentRequest.body) as Map)['limit'], 30);
        expect(result.tags, hasLength(30));
      },
    );

    test('represents a valid empty search as an empty result list', () async {
      final result = await _client(
        MockClient((_) async => _jsonResponse({'results': []})),
      ).search(query: 'no match', cancellation: AgentCancellation());

      expect(result.tags, isEmpty);
    });

    test(
      'treats malformed JSON and malformed envelopes as service errors',
      () async {
        final invalidJson = _client(
          MockClient((_) async => http.Response('{broken', 200)),
        ).search(query: 'x', cancellation: AgentCancellation());
        final missingResults = _client(
          MockClient((_) async => _jsonResponse({'items': []})),
        ).search(query: 'x', cancellation: AgentCancellation());
        final invalidRow = _client(
          MockClient(
            (_) async => _jsonResponse({
              'results': ['tag'],
            }),
          ),
        ).search(query: 'x', cancellation: AgentCancellation());

        await expectLater(invalidJson, throwsA(isA<AgentException>()));
        await expectLater(missingResults, throwsA(isA<AgentException>()));
        await expectLater(invalidRow, throwsA(isA<AgentException>()));
      },
    );

    test('stops at redirects and HTTP errors without retrying', () async {
      var calls = 0;
      final client = MockClient((request) async {
        calls++;
        expect(request.followRedirects, isFalse);
        return http.Response(
          '',
          302,
          headers: {'location': 'https://other.example'},
        );
      });

      await expectLater(
        _client(client).search(
          query: 'x',
          cancellation: AgentCancellation(),
          baseUrl: 'https://tags.example',
        ),
        throwsA(isA<AgentException>()),
      );
      expect(calls, 1);
    });

    test('validates HTTPS and loopback-only HTTP roots', () {
      expect(
        normalizeDanbooruBaseUrl('https://tags.example/root///'),
        'https://tags.example/root',
      );
      expect(
        normalizeDanbooruBaseUrl('http://localhost:8080'),
        'http://localhost:8080',
      );
      expect(
        normalizeDanbooruBaseUrl('http://127.0.0.2:8080'),
        'http://127.0.0.2:8080',
      );
      expect(
        normalizeDanbooruBaseUrl('http://[::1]:8080'),
        'http://[::1]:8080',
      );

      for (final value in [
        'https://user:secret@tags.example',
        'https://tags.example?token=secret',
        'https://tags.example/#fragment',
        'http://192.168.1.2:8080',
        'http://localhost.evil.example',
        'ftp://tags.example',
      ]) {
        expect(
          () => normalizeDanbooruBaseUrl(value),
          throwsA(isA<AgentException>()),
          reason: value,
        );
      }
    });

    test('bounds long display fields and serialized values', () async {
      final result = await _client(
        MockClient(
          (_) async => _jsonResponse({
            'results': [
              {'tag': 'long_tag', 'cn_name': 'n' * 600, 'wiki': 'w' * 5000},
            ],
          }),
        ),
      ).search(query: 'x', cancellation: AgentCancellation());
      final tag = result.tags.single;

      expect(tag.cnName.length, 500);
      expect(tag.wiki.length, 4096);
      expect(tag.toJson()['wiki'].toString().length, 4096);
      expect(
        DanbooruTag(tag: 't' * 250).toJson()['tag'].toString().length,
        200,
      );
    });

    test('rejects responses larger than one MiB', () async {
      final client = MockClient(
        (_) async => http.Response('{"padding":"${'x' * (1024 * 1024)}"}', 200),
      );

      await expectLater(
        _client(client).search(query: 'x', cancellation: AgentCancellation()),
        throwsA(isA<AgentException>()),
      );
    });

    test('times out and closes the owned client', () async {
      final client = _PendingClient();
      final search = HttpDanbooruSearchClient(
        clientFactory: () => client,
        timeout: const Duration(milliseconds: 20),
      ).search(query: 'x', cancellation: AgentCancellation());

      await expectLater(search, throwsA(isA<AgentException>()));
      expect(client.isClosed, isTrue);
    });

    test(
      'cancellation remains AgentCancelled and closes the owned client',
      () async {
        final client = _PendingClient();
        final cancellation = AgentCancellation();
        final search = HttpDanbooruSearchClient(clientFactory: () => client)
            .search(query: 'x', cancellation: cancellation);

        await client.started.future;
        cancellation.cancel();

        await expectLater(search, throwsA(isA<AgentCancelled>()));
        expect(client.isClosed, isTrue);
      },
    );
  });
}

HttpDanbooruSearchClient _client(http.Client client) =>
    HttpDanbooruSearchClient(clientFactory: () => client);

http.Response _jsonResponse(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json'},
);

class _PendingClient extends http.BaseClient {
  final started = Completer<void>();
  final _response = Completer<http.StreamedResponse>();
  bool isClosed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (!started.isCompleted) started.complete();
    return _response.future;
  }

  @override
  void close() {
    isClosed = true;
  }
}
