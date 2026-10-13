import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/references/vibe_encoding_scope.dart';
import 'package:worldpainter_pc/references/vibe_library.dart';

void main() {
  group('VibeLibrary', () {
    test(
      'serializes named entries and supports search, rename, and delete',
      () {
        final library = VibeLibrary();
        final entry = _addEntry(library, title: 'Blue Lantern');

        final restored = VibeLibrary.fromJson(
          Map<String, dynamic>.from(library.toJson()),
        );
        expect(restored.entries, hasLength(1));
        expect(restored.entries.single.title, 'Blue Lantern');
        expect(restored.entries.single.sourceAssetRef, entry.sourceAssetRef);
        expect(restored.entries.single.sourceSha256, entry.sourceSha256);
        expect(
          restored.entries.single.encodedBytes,
          utf8.encode('encoded-vibe'),
        );
        expect(restored.entries.single.model, 'nai-diffusion-4-5-curated');
        expect(restored.entries.single.providerProtocol, 'gateway7877');
        expect(restored.entries.single.endpoint, 'https://gateway.example');
        expect(restored.entries.single.informationExtracted, 0.72);
        expect(restored.entries.single.strength, 0.41);
        expect(restored.search('lantern').single.id, entry.id);

        final connection = ServiceConnection(
          protocol: 'gateway7877',
          baseUrl: 'https://GATEWAY.example:443/',
        );
        expect(
          restored.entries.single.isCompatible(
            'nai-v4.5-curated',
            connection,
            informationExtracted: 0.72,
            sourceAssetRef: entry.sourceAssetRef,
            sourceSha256: entry.sourceSha256,
          ),
          isTrue,
        );
        expect(
          restored.entries.single.toReference().hasScopedEncodedVibe,
          isTrue,
        );
        final reference = restored.entries.single.toReference();
        final restoredReference = VibeReference.fromJson(
          Map<String, dynamic>.from(reference.toJson()),
        );
        expect(
          restoredReference.encodedVibeScope?.cacheKey,
          reference.encodedVibeScope?.cacheKey,
        );
        final changedInformation = restoredReference.copyWith(
          informationExtracted: 0.5,
          clearEncodedVibe: true,
        );
        expect(changedInformation.encodedVibe, isNull);
        expect(changedInformation.encodedVibeScope, isNull);

        restored.rename(entry.id, 'Night Harbor');
        expect(restored.search('blue'), isEmpty);
        expect(restored.search('harbor').single.title, 'Night Harbor');
        expect(restored.delete(entry.id), isTrue);
        expect(restored.entries, isEmpty);
        expect(restored.delete(entry.id), isFalse);
      },
    );

    test(
      'persists the bounded cache and reuses it after restoring JSON',
      () async {
        final library = VibeLibrary(cacheCapacity: 1);
        var encodeCount = 0;
        final firstScope = _scope('a');
        await library.getOrEncode(
          scope: firstScope,
          encode: () async {
            encodeCount++;
            return Uint8List.fromList(utf8.encode('one'));
          },
        );
        await library.getOrEncode(
          scope: _scope('b'),
          encode: () async {
            encodeCount++;
            return Uint8List.fromList(utf8.encode('two'));
          },
        );
        expect(library.cacheEntries, hasLength(1));

        final restored = VibeLibrary.fromJson(
          Map<String, dynamic>.from(library.toJson()),
        );
        final cacheHit = await restored.getOrEncode(
          scope: _scope('b'),
          encode: () async {
            encodeCount++;
            return Uint8List.fromList(utf8.encode('wrong'));
          },
        );
        expect(cacheHit.encodedValue, 'two');
        expect(encodeCount, 2);
      },
    );

    test(
      'shares an in-flight encode and excludes generation strength',
      () async {
        final library = VibeLibrary();
        final gate = Completer<Uint8List>();
        var encodeCount = 0;
        final first = library.getOrEncode(
          scope: _scope('a'),
          encode: () {
            encodeCount++;
            return gate.future;
          },
        );
        final second = library.getOrEncode(
          scope: _scope('a'),
          encode: () async {
            encodeCount++;
            return Uint8List.fromList(utf8.encode('duplicate'));
          },
        );
        await Future<void>.delayed(Duration.zero);
        expect(encodeCount, 1);
        gate.complete(Uint8List.fromList(utf8.encode('shared')));
        final values = await Future.wait([first, second]);
        expect(values.map((value) => value.encodedValue), ['shared', 'shared']);

        const lowStrength = VibeReference(assetId: 'asset', strength: 0.1);
        const highStrength = VibeReference(assetId: 'asset', strength: 0.9);
        expect(lowStrength.strength, isNot(highStrength.strength));
        final hit = await library.getOrEncode(
          scope: _scope('a'),
          encode: () async {
            encodeCount++;
            return Uint8List.fromList(utf8.encode('should-not-run'));
          },
        );
        expect(hit.encodedValue, 'shared');
        expect(encodeCount, 1);
      },
    );

    test(
      'a failed encode is not cached and imported values stay scoped',
      () async {
        final library = VibeLibrary();
        final scope = _scope('a');
        await expectLater(
          library.getOrEncode(
            scope: scope,
            encode: () async => throw const FormatException('mock failure'),
          ),
          throwsFormatException,
        );
        expect(library.cacheEntries, isEmpty);

        final entry = library.addPreEncodedEntry(
          title: 'Imported metadata',
          encodedBytes: Uint8List.fromList(utf8.encode('opaque-encoding')),
          model: 'nai-diffusion-4-5-curated',
          providerProtocol: 'gateway7877',
          endpoint: Uri.parse('https://gateway.example'),
          informationExtracted: 1.0,
        );
        final reference = entry.toReference();
        expect(reference.assetId, isEmpty);
        expect(
          reference.hasCompatibleImportedEncoding(
            model: 'nai-v4.5-curated',
            providerProtocol: 'gateway7877',
            endpoint: Uri.parse('https://gateway.example/'),
          ),
          isTrue,
        );
        expect(
          reference.hasCompatibleImportedEncoding(
            model: 'nai-v4.5-full',
            providerProtocol: 'gateway7877',
            endpoint: Uri.parse('https://gateway.example/'),
          ),
          isFalse,
        );
        expect(
          VibeReference.fromJson({
            'asset_id': '',
            'encoded_vibe': 'legacy-opaque-value',
            'strength': 0.3,
            'information_extracted': 1.0,
          }).hasUnverifiedEncodedVibe,
          isTrue,
        );
      },
    );
  });
}

VibeLibraryEntry _addEntry(VibeLibrary library, {required String title}) =>
    library.addEntry(
      title: title,
      sourceAssetRef: 'sha256/aa/${'a' * 64}.png',
      sourceSha256: 'a' * 64,
      encodedBytes: Uint8List.fromList(utf8.encode('encoded-vibe')),
      model: 'nai-v4.5-curated',
      providerProtocol: 'gateway7877',
      endpoint: Uri.parse('https://gateway.example/'),
      informationExtracted: 0.72,
      strength: 0.41,
      createdAt: DateTime.utc(2026, 10, 13),
    );

VibeEncodingScope _scope(String digestPrefix) {
  final digest = digestPrefix.padRight(64, digestPrefix);
  return VibeEncodingScope(
    sourceAssetRef: 'sha256/${digest.substring(0, 2)}/$digest.png',
    sourceSha256: digest,
    model: 'nai-v4.5-curated',
    providerProtocol: 'gateway7877',
    endpoint: Uri.parse('https://gateway.example/'),
    informationExtracted: 0.72,
  );
}
