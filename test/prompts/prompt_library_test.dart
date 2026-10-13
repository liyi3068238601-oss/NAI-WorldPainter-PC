import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/prompts/prompt_library.dart';

void main() {
  group('PromptLibrary persistence', () {
    test('round trips exact prompt text, weights, and timestamps', () {
      final library = PromptLibrary(groups: const ['Painter']);
      library.addStyle(
        id: 'style-1',
        name: 'Soft light',
        prompt: 'soft light,\n  warm colors ',
        negative: 'low quality\ntext',
        category: 'Lighting',
        previewAssetRef: _managedAssetRef(),
        createdAt: DateTime.utc(2026, 10, 1, 2, 3, 4),
      );
      library.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample\n  keep spaces ',
        categories: const ['Painter'],
        defaultWeight: 1.23456789,
        useCount: 4,
        lastUsedAt: DateTime.utc(2026, 10, 2),
        danbooruCount: 321,
        createdAt: DateTime.utc(2026, 9, 1),
      );

      final encoded = jsonEncode(library.toJson());
      final restored = PromptLibrary.fromJson(
        Map<String, dynamic>.from(jsonDecode(encoded) as Map),
      );

      expect(restored.toJson(), library.toJson());
      expect(restored.styles.single.prompt, 'soft light,\n  warm colors ');
      expect(restored.styles.single.negative, 'low quality\ntext');
      expect(restored.artists.single.prompt, 'artist:sample\n  keep spaces ');
      expect(restored.artists.single.defaultWeight, 1.23456789);
      expect(restored.artists.single.categories, ['Painter']);
    });

    test('rejects damaged schema, unknown fields, and inconsistent groups', () {
      final library = PromptLibrary(groups: const ['Portrait']);
      library.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample',
        categories: const ['Portrait'],
      );
      final valid = library.toJson();

      expect(
        () => PromptLibrary.fromJson({...valid, 'schema': 2}),
        throwsFormatException,
      );
      expect(
        () => PromptLibrary.fromJson({...valid, 'unexpected': true}),
        throwsFormatException,
      );
      expect(
        () => PromptLibrary.fromJson({
          ...valid,
          'artists': [
            (valid['artists'] as List).single,
            (valid['artists'] as List).single,
          ],
        }),
        throwsFormatException,
      );

      final artistJson = Map<String, dynamic>.from(
        (valid['artists'] as List).single as Map,
      );
      artistJson['categories'] = ['Missing'];
      expect(
        () => PromptLibrary.fromJson({
          ...valid,
          'artists': [artistJson],
        }),
        throwsFormatException,
      );
    });

    test('rejects malformed style and artist records', () {
      final base = PromptLibrary(groups: const ['Portrait']);
      base.addStyle(
        id: 'style-1',
        name: 'Portrait',
        prompt: 'portrait',
        negative: '',
        category: 'People',
        createdAt: DateTime.utc(2026),
      );
      base.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample',
        categories: const ['Portrait'],
      );
      final valid = base.toJson();

      final badStyle = Map<String, dynamic>.from(
        (valid['styles'] as List).single as Map,
      )..remove('negative');
      expect(
        () => PromptLibrary.fromJson({
          ...valid,
          'styles': [badStyle],
        }),
        throwsFormatException,
      );

      final styleWithUnmanagedRef = Map<String, dynamic>.from(
        (valid['styles'] as List).single as Map,
      )..['preview_asset_ref'] = 'C:/Users/user/preview.png';
      expect(
        () => PromptLibrary.fromJson({
          ...valid,
          'styles': [styleWithUnmanagedRef],
        }),
        throwsFormatException,
      );

      final badArtist = Map<String, dynamic>.from(
        (valid['artists'] as List).single as Map,
      )..['default_weight'] = double.nan;
      expect(
        () => PromptLibrary.fromJson({
          ...valid,
          'artists': [badArtist],
        }),
        throwsFormatException,
      );

      expect(
        () => base.addStyle(
          name: 'Empty',
          prompt: '  ',
          negative: '',
          category: 'People',
        ),
        throwsFormatException,
      );
      expect(
        () => base.addArtist(name: 'Empty', prompt: '\n  '),
        throwsFormatException,
      );
      expect(
        () => base.addStyle(
          name: 'Unmanaged preview',
          prompt: 'portrait',
          negative: '',
          category: 'People',
          previewAssetRef: 'file:///tmp/preview.png',
        ),
        throwsFormatException,
      );
    });
  });

  group('PromptLibrary groups and mutations', () {
    test('creates, updates, searches, and deletes styles and artists', () {
      final library = PromptLibrary(groups: const ['Portrait', 'Landscape']);
      final createdAt = DateTime.utc(2026, 1, 1);
      final style = library.addStyle(
        id: 'style-1',
        name: 'Soft light',
        prompt: 'soft light',
        negative: 'low contrast',
        category: 'Lighting',
        previewAssetRef: _managedAssetRef(),
        createdAt: createdAt,
      );
      final artist = library.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample',
        categories: const ['Portrait'],
        createdAt: createdAt,
      );

      final updatedStyle = library.updateStyle(
        style.copyWith(name: 'Night light', clearPreviewAssetRef: true),
      );
      final updatedArtist = library.updateArtist(
        artist.copyWith(categories: const []),
      );
      expect(updatedStyle.name, 'Night light');
      expect(updatedStyle.previewAssetRef, isNull);
      expect(updatedStyle.createdAt, createdAt);
      expect(updatedArtist.categories, [PromptLibrary.ungroupedCategory]);
      expect(updatedArtist.createdAt, createdAt);
      expect(library.searchStyles('night').single.id, style.id);
      expect(library.searchArtists('sample').single.id, artist.id);

      expect(library.deleteStyle(style.id), isTrue);
      expect(library.deleteStyle(style.id), isFalse);
      expect(library.deleteArtist(artist.id), isTrue);
      expect(library.deleteArtist(artist.id), isFalse);
      expect(library.styles, isEmpty);
      expect(library.artists, isEmpty);
    });

    test('keeps empty groups and moves members when a group is deleted', () {
      var notifications = 0;
      final library = PromptLibrary(onChanged: (_) => notifications++);
      library.addGroup('Portrait');
      library.addGroup('Landscape');
      library.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample',
        categories: const ['Portrait', 'Landscape'],
      );

      expect(library.renameGroup('Portrait', 'Figure'), isTrue);
      expect(library.artists.single.categories, ['Figure', 'Landscape']);
      expect(library.groups, ['Figure', 'Landscape']);
      expect(library.deleteGroup('Figure'), isTrue);
      expect(library.artists.single.categories, ['Landscape']);
      expect(library.deleteGroup('Landscape'), isTrue);
      expect(library.artists.single.categories, [
        PromptLibrary.ungroupedCategory,
      ]);
      expect(library.groups, isEmpty);
      expect(notifications, 6);
    });

    test('exposes read-only collection and category views', () {
      final library = PromptLibrary(groups: const ['Portrait']);
      final artist = library.addArtist(
        name: 'A Painter',
        prompt: 'artist:sample',
        categories: const ['Portrait'],
      );
      expect(() => library.groups.add('Other'), throwsUnsupportedError);
      expect(() => library.artists.clear(), throwsUnsupportedError);
      expect(() => artist.categories.add('Other'), throwsUnsupportedError);
      expect(
        () => library.searchArtists('Painter').clear(),
        throwsUnsupportedError,
      );
    });

    test('updates use recency separately from edit recency', () {
      final created = DateTime.utc(2026, 1, 1);
      final library = PromptLibrary(groups: const ['Portrait']);
      final artist = library.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample',
        categories: const ['Portrait'],
        createdAt: created,
      );
      final used = library.recordArtistUse(
        artist.id,
        usedAt: DateTime.utc(2026, 10, 1),
      );

      expect(used.useCount, 1);
      expect(used.lastUsedAt, DateTime.utc(2026, 10, 1));
      expect(used.updatedAt, created);
      expect(library.sortedArtists().single.updatedAt, created);
    });
  });

  group('PromptLibrary artist prompt composition', () {
    test('preserves prompt whitespace and weight precision in NAI syntax', () {
      final library = PromptLibrary();
      final plain = library.addArtist(
        id: 'plain',
        name: 'Plain',
        prompt: '  artist:plain\nline two ',
        createdAt: DateTime.utc(2026, 1, 2),
      );
      final weighted = library.addArtist(
        id: 'weighted',
        name: 'Weighted',
        prompt: 'artist:weighted,\n  keep this ',
        createdAt: DateTime.utc(2026, 1, 1),
      );

      expect(
        library.composeArtistPrompt({plain.id: 1.0, weighted.id: 1.23456789}),
        '  artist:plain\nline two , 1.23456789::artist:weighted,\n  keep this ::',
      );
    });

    test('accepts supported finite weights and rejects invalid values', () {
      final library = PromptLibrary();
      final artist = library.addArtist(
        id: 'artist-1',
        name: 'A Painter',
        prompt: 'artist:sample',
      );

      expect(
        library.composeArtistPrompt({artist.id: 0.1}),
        '0.1::artist:sample::',
      );
      expect(
        library.composeArtistPrompt({artist.id: 8.0}),
        '8.0::artist:sample::',
      );
      for (final invalid in [0.0, -0.1, 8.1, double.nan, double.infinity]) {
        expect(
          () => library.composeArtistPrompt({artist.id: invalid}),
          throwsFormatException,
        );
      }
      expect(
        () => library.addArtist(
          name: 'Invalid',
          prompt: 'artist:invalid',
          defaultWeight: double.infinity,
        ),
        throwsFormatException,
      );
    });
  });

  group('PromptLibrary search, sorting, and mobile export', () {
    test('searches records and sorts artists by name, edit time, or heat', () {
      final library = PromptLibrary(groups: const ['Portrait']);
      library.addArtist(
        id: 'artist-b',
        name: 'Beta',
        prompt: 'artist:beta',
        categories: const ['Portrait'],
        danbooruCount: 90,
        createdAt: DateTime.utc(2026, 1, 1),
      );
      library.addArtist(
        id: 'artist-a',
        name: 'Alpha',
        prompt: 'artist:alpha',
        categories: const ['Portrait'],
        danbooruCount: 10,
        createdAt: DateTime.utc(2026, 2, 1),
      );

      expect(library.searchArtists('BETA').single.name, 'Beta');
      expect(
        library.sortedArtists(order: PromptSortOrder.name).map((a) => a.name),
        ['Alpha', 'Beta'],
      );
      expect(
        library
            .sortedArtists(order: PromptSortOrder.popularity)
            .map((a) => a.name),
        ['Beta', 'Alpha'],
      );
      expect(library.sortedArtists().map((a) => a.name), ['Alpha', 'Beta']);
    });

    test(
      'exports the confirmed phone v12 field shape with unique numeric IDs',
      () {
        final library = PromptLibrary(groups: const ['Portrait', 'Empty']);
        library.addArtist(
          id: 'artist-one',
          name: 'One',
          prompt: 'artist:one',
          categories: const ['Portrait'],
          danbooruCount: 22,
          createdAt: DateTime.utc(2026, 1, 1),
        );
        library.addArtist(id: 'artist-two', name: 'Two', prompt: 'artist:two');

        final exported = jsonDecode(library.toMobileExportJson()) as Map;
        expect(exported.keys.toSet(), {
          'version',
          'artists',
          'categories',
          'presets',
        });
        expect(exported['version'], 12);
        expect(exported['categories'], ['Portrait', 'Empty']);
        expect(exported['presets'], isEmpty);
        final artists = (exported['artists'] as List).cast<Map>();
        expect(artists.map((artist) => artist['id']).toSet(), {1, 2});
        expect(artists.first.keys.toSet(), {
          'id',
          'name',
          'tag',
          'imageUrl',
          'categories',
          'danbooruCount',
          'createdAt',
        });
        expect(artists.first['tag'], 'artist:one');
        expect(artists.last['categories'], ['未分类']);
      },
    );
  });
}

String _managedAssetRef() {
  final digest = List<String>.filled(64, 'a').join();
  return 'sha256/${digest.substring(0, 2)}/$digest.png';
}
