import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/prompt_memory.dart';

void main() {
  group('PromptMemoryLibrary', () {
    test('starts empty and exposes immutable entries', () {
      final library = PromptMemoryLibrary();

      expect(library.entries, isEmpty);
      expect(library.revision, 0);
      expect(
        () => library.entries.add(_entry('outside', 'trigger', 'content')),
        throwsA(isA<UnsupportedError>()),
      );
      expect(MemoryKind.characterName.label, '人名');
      expect(MemoryKind.characterName.wireName, 'character_name');
      expect(MemorySource.pendingLlmCandidate.label, '待审核候选');
    });

    test('normalizes trigger whitespace and reports unresolved conflicts', () {
      final library = PromptMemoryLibrary();
      final first = library.save(
        trigger: '  red\t fox  ',
        content: 'A red fox',
        kind: MemoryKind.fact,
        now: _date(1),
      );
      final revision = library.revision;

      expect(first.trigger, 'red fox');
      expect(library.conflicts('red   fox'), [first]);
      expect(
        () => library.save(
          trigger: 'red\nfox',
          content: 'Another red fox',
          kind: MemoryKind.fact,
          now: _date(2),
        ),
        throwsA(
          isA<MemoryConflictException>().having(
            (error) => error.entries,
            'entries',
            [first],
          ),
        ),
      );
      expect(library.revision, revision);
      expect(library.entries, [first]);
    });

    test('replace keeps the old entry as non-retrievable history', () {
      final library = PromptMemoryLibrary();
      final old = library.save(
        trigger: 'pilot',
        content: 'The pilot wears red.',
        kind: MemoryKind.fact,
        now: _date(1),
      );
      final replacement = library.save(
        trigger: 'pilot',
        content: 'The pilot wears blue.',
        kind: MemoryKind.fact,
        resolution: MemoryResolution.replace,
        now: _date(2),
      );

      expect(library.entries, hasLength(2));
      expect(library.entries.first.supersededBy, replacement.id);
      expect(old.id, library.entries.first.id);
      expect(library.entries.first.isRetrievable, isFalse);
      expect(replacement.isRetrievable, isTrue);
      final retrieved = library.retrieve('pilot');
      expect(retrieved.map((entry) => entry.id), [replacement.id]);
      expect(retrieved.single.hitCount, 1);
    });

    test(
      'changing an active trigger preserves serializable history lineage',
      () {
        final library = PromptMemoryLibrary();
        final old = library.save(
          trigger: '星璃',
          content: '银色头发',
          kind: MemoryKind.characterFeature,
          now: _date(1),
        );
        final active = library.save(
          trigger: '星璃',
          content: '白色短发',
          kind: MemoryKind.characterFeature,
          resolution: MemoryResolution.replace,
          now: _date(2),
        );

        final edited = library.save(
          id: active.id,
          trigger: '星璃角色',
          content: '白色短发',
          kind: MemoryKind.characterFeature,
          now: _date(3),
        );

        expect(edited.id, active.id);
        expect(library.entries.first.supersededBy, active.id);
        expect(library.entries.first.trigger, old.trigger);
        expect(
          PromptMemoryLibrary.fromJson(library.toJson()).toJson(),
          library.toJson(),
        );
        final beforeRejectedEdit = library.toJson();
        final revisionBeforeRejectedEdit = library.revision;
        expect(
          () => library.save(
            id: old.id,
            trigger: old.trigger,
            content: 'Changed archived content',
            kind: old.kind,
          ),
          throwsA(isA<StateError>()),
        );
        expect(library.toJson(), beforeRejectedEdit);
        expect(library.revision, revisionBeforeRejectedEdit);
        expect(
          PromptMemoryLibrary.fromJson(library.toJson()).toJson(),
          library.toJson(),
        );
      },
    );

    test('merge preserves both texts and supersedes the source entry', () {
      final library = PromptMemoryLibrary();
      library.save(
        trigger: 'studio style',
        content: 'Soft shadows',
        kind: MemoryKind.style,
        now: _date(1),
      );
      final merged = library.save(
        trigger: 'studio style',
        content: 'Muted colors',
        kind: MemoryKind.style,
        resolution: MemoryResolution.merge,
        now: _date(2),
      );

      expect(merged.content, 'Muted colors\n---\nSoft shadows');
      expect(library.entries.first.supersededBy, merged.id);
      final retrieved = library.retrieve('studio');
      expect(retrieved.single.id, merged.id);
      expect(retrieved.single.content, merged.content);
    });

    test('coexist keeps every same-trigger entry active', () {
      final library = PromptMemoryLibrary();
      final first = library.save(
        trigger: 'hero',
        content: 'Long hair',
        kind: MemoryKind.characterFeature,
        now: _date(1),
      );
      final second = library.save(
        trigger: 'hero',
        content: 'Green eyes',
        kind: MemoryKind.characterFeature,
        resolution: MemoryResolution.coexist,
        now: _date(2),
      );

      expect(library.conflicts('hero'), [second, first]);
      expect(first.isRetrievable, isTrue);
      expect(second.isRetrievable, isTrue);
    });

    test(
      'pending proposals coexist, deduplicate, and stay out of retrieval',
      () {
        final library = PromptMemoryLibrary();
        final active = library.save(
          trigger: 'same subject',
          content: 'Accepted fact',
          kind: MemoryKind.fact,
        );
        final pending = library.save(
          trigger: 'same subject',
          content: 'Unreviewed proposal',
          kind: MemoryKind.fact,
          source: MemorySource.pendingLlmCandidate,
          resolution: MemoryResolution.replace,
        );
        final revision = library.revision;
        final duplicate = library.save(
          trigger: ' same   subject ',
          content: ' Unreviewed proposal ',
          kind: MemoryKind.fact,
          source: MemorySource.pendingLlmCandidate,
        );

        expect(duplicate.id, pending.id);
        expect(library.revision, revision);
        expect(library.entries, [active, pending]);
        expect(library.conflicts('same subject'), [active]);
        expect(active.supersededBy, isNull);
        expect(active.isRetrievable, isTrue);
        expect(pending.isRetrievable, isFalse);
        expect(library.retrieve('same subject').map((entry) => entry.id), [
          active.id,
        ]);
        expect(library.search('same subject'), contains(pending));
        expect(pending.hitCount, 0);
      },
    );

    test('approve promotes a pending entry in place with edited fields', () {
      final library = PromptMemoryLibrary();
      final pending = library.save(
        trigger: 'rough trigger',
        content: 'Rough proposal',
        kind: MemoryKind.other,
        source: MemorySource.pendingLlmCandidate,
        now: _date(1),
      );

      final approved = library.approve(
        pending.id,
        trigger: '  final\t trigger ',
        content: 'Reviewed fact',
        kind: MemoryKind.fact,
        now: _date(2),
      );

      expect(approved.id, pending.id);
      expect(approved.trigger, 'final trigger');
      expect(approved.content, 'Reviewed fact');
      expect(approved.kind, MemoryKind.fact);
      expect(approved.source, MemorySource.llmCandidate);
      expect(approved.createdAt, pending.createdAt);
      expect(approved.isRetrievable, isTrue);
      final retrieved = library.retrieve('final trigger');
      expect(retrieved.single.id, pending.id);
      expect(retrieved.single.hitCount, 1);
    });

    test('editing a pending entry does not bypass approval', () {
      final library = PromptMemoryLibrary();
      final pending = library.save(
        trigger: 'candidate',
        content: 'Initial proposal',
        kind: MemoryKind.observation,
        source: MemorySource.pendingLlmCandidate,
      );

      final edited = library.save(
        id: pending.id,
        trigger: 'candidate',
        content: 'Edited proposal',
        kind: MemoryKind.observation,
      );

      expect(edited.source, MemorySource.pendingLlmCandidate);
      expect(edited.isRetrievable, isFalse);
      expect(library.retrieve('candidate'), isEmpty);
    });

    test(
      'approve requires an explicit strategy when its trigger conflicts',
      () {
        final library = PromptMemoryLibrary();
        final active = library.save(
          trigger: 'shared trigger',
          content: 'Existing fact',
          kind: MemoryKind.fact,
        );
        final pending = library.save(
          trigger: 'shared trigger',
          content: 'Candidate fact',
          kind: MemoryKind.fact,
          source: MemorySource.pendingLlmCandidate,
          resolution: MemoryResolution.coexist,
        );
        final revision = library.revision;

        expect(
          () => library.approve(pending.id),
          throwsA(isA<MemoryConflictException>()),
        );
        expect(library.revision, revision);
        expect(library.entries.first, active);
        expect(library.entries.last.source, MemorySource.pendingLlmCandidate);

        final approved = library.approve(
          pending.id,
          resolution: MemoryResolution.replace,
          now: _date(3),
        );
        expect(approved.id, pending.id);
        expect(approved.source, MemorySource.llmCandidate);
        expect(library.entries.first.supersededBy, pending.id);
        expect(library.conflicts('shared trigger'), [approved]);
      },
    );

    test('retrieve skips oversized entries intact and records hits only for returns', () {
      final library = PromptMemoryLibrary();
      final large = library.save(
        trigger: 'owl close',
        content: 'This whole entry must remain intact.',
        kind: MemoryKind.observation,
        now: _date(2),
      );
      final small = library.save(
        trigger: 'owl',
        content: 'x',
        kind: MemoryKind.observation,
        now: _date(1),
      );

      final results = library.retrieve(
        'owl close',
        maxCharacters: small.trigger.length + small.content.length,
        now: _date(3),
      );

      expect(results.map((entry) => entry.id), [small.id]);
      expect(results.single.content, 'x');
      expect(library.entries.first.hitCount, 0);
      expect(library.entries.last.hitCount, 1);
      expect(library.entries.last.lastHitAt, _date(3));
      expect(library.entries.last.updatedAt, _date(3));
      expect(library.retrieve('close', maxCharacters: 2), isEmpty);
      expect(library.entries.first.hitCount, 0);
      expect(large.content, 'This whole entry must remain intact.');
    });

    test(
      'retrieve matches a CJK trigger embedded in a natural-language query',
      () {
        final library = PromptMemoryLibrary();
        final memory = library.save(
          trigger: '星璃',
          content: '银色头发',
          kind: MemoryKind.characterFeature,
          now: _date(1),
        );

        final retrieved = library.retrieve('请画星璃', now: _date(2));

        expect(retrieved.map((entry) => entry.id), [memory.id]);
        expect(retrieved.single.hitCount, 1);
        expect(library.retrieve('。。。'), isEmpty);
        expect(library.entries.single.hitCount, 1);
      },
    );

    test('management search filters entries without changing hit counts', () {
      final library = PromptMemoryLibrary();
      final manual = library.save(
        trigger: 'silver fox',
        content: 'Likes winter scenes',
        kind: MemoryKind.preference,
        source: MemorySource.manual,
      );
      library.save(
        trigger: 'silver fox',
        content: 'Candidate text',
        kind: MemoryKind.preference,
        source: MemorySource.pendingLlmCandidate,
        resolution: MemoryResolution.coexist,
      );

      expect(
        library.search(
          'silver',
          kind: MemoryKind.preference,
          source: MemorySource.manual,
        ),
        [manual],
      );
      expect(manual.hitCount, 0);
    });

    test('stale returns only old, unused active entries', () {
      final library = PromptMemoryLibrary();
      final now = DateTime.utc(2026, 10, 14);
      final oldTime = now.subtract(const Duration(days: 100));
      final old = library.save(
        trigger: 'old',
        content: 'Unused old memory',
        kind: MemoryKind.fact,
        now: oldTime,
      );
      final fresh = library.save(
        trigger: 'fresh',
        content: 'New memory has never been hit',
        kind: MemoryKind.fact,
        now: now,
      );
      final pending = library.save(
        trigger: 'pending',
        content: 'Candidate',
        kind: MemoryKind.fact,
        source: MemorySource.pendingLlmCandidate,
        now: oldTime,
      );
      final recentlyHit = library.save(
        trigger: 'recently hit',
        content: 'Used memory',
        kind: MemoryKind.fact,
        now: oldTime,
      );
      library.retrieve(
        'recently hit',
        now: now.subtract(const Duration(days: 1)),
      );
      final superseded = library.save(
        trigger: 'replaced',
        content: 'Old version',
        kind: MemoryKind.fact,
        now: oldTime,
      );
      library.save(
        trigger: 'replaced',
        content: 'New version',
        kind: MemoryKind.fact,
        resolution: MemoryResolution.replace,
        now: now,
      );

      expect(library.stale(now: now), [old]);
      expect(fresh.hitCount, 0);
      expect(pending.isRetrievable, isFalse);
      expect(
        library.entries
            .firstWhere((entry) => entry.id == recentlyHit.id)
            .hitCount,
        1,
      );
      expect(
        library.entries
            .firstWhere((entry) => entry.id == superseded.id)
            .isRetrievable,
        isFalse,
      );
    });

    test('deleting a replacement target removes superseded ancestors only', () {
      final library = PromptMemoryLibrary();
      final first = library.save(
        trigger: 'chain',
        content: 'first',
        kind: MemoryKind.fact,
      );
      final second = library.save(
        trigger: 'chain',
        content: 'second',
        kind: MemoryKind.fact,
        resolution: MemoryResolution.replace,
      );
      final third = library.save(
        trigger: 'chain',
        content: 'third',
        kind: MemoryKind.fact,
        resolution: MemoryResolution.replace,
      );

      expect(library.deletionClosure({third.id}), {
        first.id,
        second.id,
        third.id,
      });
      expect(library.deletionClosure({'unknown'}), isEmpty);
      library.delete({first.id});
      expect(library.entries.map((entry) => entry.id), [second.id, third.id]);
      library.delete({third.id});
      expect(library.entries, isEmpty);
    });

    test('round-trips schema 1 and rejects malformed serialized state', () {
      final library = PromptMemoryLibrary();
      final old = library.save(
        trigger: '  red\t fox ',
        content: 'A fox in the snow.',
        kind: MemoryKind.fact,
        now: _date(1),
      );
      library.save(
        trigger: 'red fox',
        content: 'A blue fox.',
        kind: MemoryKind.fact,
        resolution: MemoryResolution.replace,
        now: _date(2),
      );
      library.retrieve('blue fox', now: _date(3));

      final decoded = PromptMemoryLibrary.fromJson(library.toJson());
      expect(decoded.toJson(), library.toJson());
      expect(decoded.revision, library.revision);
      expect(
        decoded.entries.first.supersededBy,
        library.entries.first.supersededBy,
      );
      expect(old.id, library.entries.first.id);

      final wrongSchema = Map<String, Object?>.of(library.toJson())
        ..['schema'] = 2;
      expect(
        () => PromptMemoryLibrary.fromJson(wrongSchema),
        throwsA(isA<FormatException>()),
      );
      final unknownField = Map<String, Object?>.of(library.toJson())
        ..['unexpected'] = true;
      expect(
        () => PromptMemoryLibrary.fromJson(unknownField),
        throwsA(isA<FormatException>()),
      );
      final danglingReference = Map<String, Object?>.of(library.toJson());
      final danglingEntries = (danglingReference['entries']! as List)
          .map((raw) => Map<String, Object?>.of(raw as Map<String, Object?>))
          .toList();
      danglingEntries.first['supersededBy'] = 'missing-id';
      danglingReference['entries'] = danglingEntries;
      expect(
        () => PromptMemoryLibrary.fromJson(danglingReference),
        throwsA(isA<FormatException>()),
      );
    });

    test('failed merge and stale revisions leave the library unchanged', () {
      final library = PromptMemoryLibrary();
      library.save(trigger: 'same', content: 'o' * 4000, kind: MemoryKind.fact);
      final before = library.toJson();
      final revision = library.revision;

      expect(
        () => library.save(
          trigger: 'same',
          content: 'n' * 4000,
          kind: MemoryKind.fact,
          resolution: MemoryResolution.merge,
        ),
        throwsArgumentError,
      );
      expect(library.toJson(), before);
      expect(
        () => library.delete({'missing'}, expectedRevision: revision - 1),
        throwsA(isA<MemoryRevisionConflictException>()),
      );
      expect(library.toJson(), before);
    });

    test('enforces input size limits before changing the library', () {
      final library = PromptMemoryLibrary();

      expect(
        () => library.save(
          trigger: 't' * 201,
          content: 'content',
          kind: MemoryKind.fact,
        ),
        throwsArgumentError,
      );
      expect(
        () => library.save(
          trigger: 'trigger',
          content: 'c' * 8001,
          kind: MemoryKind.fact,
        ),
        throwsArgumentError,
      );
      expect(library.revision, 0);

      expect(
        () => PromptMemoryLibrary.fromJson({
          'schema': 1,
          'revision': 0,
          'entries': List<Object?>.filled(5001, null),
        }),
        throwsA(isA<FormatException>()),
      );
    });
  });
}

MemoryEntry _entry(String id, String trigger, String content) => MemoryEntry(
  id: id,
  trigger: trigger,
  content: content,
  kind: MemoryKind.other,
  source: MemorySource.manual,
  hitCount: 0,
  lastHitAt: null,
  createdAt: _date(1),
  updatedAt: _date(1),
  supersededBy: null,
);

DateTime _date(int day) => DateTime.utc(2026, 1, day);
