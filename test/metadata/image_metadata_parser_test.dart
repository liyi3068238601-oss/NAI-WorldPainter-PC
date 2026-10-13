import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/metadata/image_metadata_parser.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'reads tEXt parameters and keeps seed zero distinct from missing',
    () async {
      final png = _pngWithText([
        _textChunk(
          'Comment',
          jsonEncode({
            'prompt': '1girl, blue hair',
            'uc': 'blurry',
            'seed': 0,
            'width': 832,
            'height': 1216,
            'steps': 28,
            'scale': 5.5,
            'cfg_rescale': 0.25,
            'sampler': 'k_euler_ancestral',
            'noise_schedule': 'karras',
            'use_coords': false,
            'model': 'nai-diffusion-4-5-full',
          }),
        ),
      ]);

      final result = await parseImageMetadata(png);

      expect(result.recognized, isTrue);
      expect(result.format, 'png');
      expect(result.source, 'png-text');
      expect(result.fields, containsPair('seed', 0));
      expect(result.fields, containsPair('prompt', '1girl, blue hair'));
      expect(result.fields, containsPair('negative_prompt', 'blurry'));
      expect(result.fields, containsPair('width', 832));
      expect(result.fields, containsPair('height', 1216));
      expect(result.fields, containsPair('steps', 28));
      expect(result.fields, containsPair('scale', 5.5));
      expect(result.fields, containsPair('cfg_rescale', 0.25));
      expect(result.fields, containsPair('sampler', 'k_euler_ancestral'));
      expect(result.fields, containsPair('noise_schedule', 'karras'));
      expect(result.fields, containsPair('use_coords', false));
      expect(result.fields, containsPair('model', 'nai-diffusion-4-5-full'));
    },
  );

  test('reads UTF-8 iTXt and zTXt compressed JSON', () async {
    final comment = jsonEncode({'prompt': '猫耳の女の子', 'seed': 17});
    final itxt = _internationalTextChunk('Comment', comment);
    final ztxt = _compressedTextChunk('Parameters', jsonEncode({'steps': 31}));

    final result = await parseImageMetadata(_pngWithText([itxt, ztxt]));

    expect(result.fields['prompt'], '猫耳の女の子');
    expect(result.fields['seed'], 17);
    expect(result.fields['steps'], 31);
  });

  test(
    'extracts v4 base and role prompts, coordinates, use_coords, and Vibe',
    () async {
      final comment = {
        'v4_prompt': {
          'caption': {
            'base_caption': 'base positive',
            'char_captions': [
              {
                'char_caption': 'character positive',
                'centers': [
                  {'x': 0.25, 'y': 0.75},
                ],
              },
            ],
          },
        },
        'v4_negative_prompt': {
          'caption': {
            'base_caption': 'base negative',
            'char_captions': [
              {'char_caption': 'character negative'},
            ],
          },
        },
        'use_coords': true,
        'reference_image_multiple': ['encoded-vibe-1', 'encoded-vibe-2'],
        'reference_strength_multiple': [0.4, 0.8],
        'reference_information_extracted_multiple': [0.7, 1.0],
      };
      final result = await parseImageMetadata(
        _pngWithText([_textChunk('Comment', jsonEncode(comment))]),
      );

      expect(result.fields['prompt'], 'base positive');
      expect(result.fields['negative_prompt'], 'base negative');
      expect(result.fields['use_coords'], isTrue);
      final characters =
          result.fields['characters'] as List<Map<String, dynamic>>;
      expect(characters.single['prompt'], 'character positive');
      expect(characters.single['negative_prompt'], 'character negative');
      expect(characters.single['center_x'], 0.25);
      expect(characters.single['center_y'], 0.75);
      final vibes =
          result.fields['vibe_references'] as List<Map<String, dynamic>>;
      expect(vibes.map((item) => item['asset_id']), everyElement(''));
      expect(vibes.map((item) => item['encoded_vibe']), [
        'encoded-vibe-1',
        'encoded-vibe-2',
      ]);
      expect(vibes.map((item) => item['strength']), [0.4, 0.8]);

      final applied = result.applyTo(
        GenerationParameters(
          model: 'nai-diffusion-4-5-full',
          prompt: '',
          width: 832,
          height: 1216,
        ),
        selectedFields: {'vibe_references'},
      );
      expect(applied.vibeReferences, hasLength(2));
      expect(applied.vibeReferences.first.encodedVibe, 'encoded-vibe-1');
      expect(applied.vibeReferences.first.hasUnverifiedEncodedVibe, isTrue);
      expect(applied.vibeReferences.first.encodedVibeScope, isNull);
    },
  );

  test('extracts v3 role prompts from the Characters system message', () async {
    final comment = {
      'prompt': 'global prompt',
      'messages': [
        {
          'role': 'system',
          'content':
              'Characters: ${jsonEncode([
                {
                  'prompt': 'first role',
                  'uc': 'first role negative',
                  'center': {'x': 0.5, 'y': 0.4},
                },
              ])}',
        },
      ],
    };

    final result = await parseImageMetadata(
      _pngWithText([_textChunk('Comment', jsonEncode(comment))]),
    );

    expect(result.fields['prompt'], 'global prompt');
    final character = (result.fields['characters'] as List).single;
    expect(character['prompt'], 'first role');
    expect(character['negative_prompt'], 'first role negative');
    expect(character['center_x'], 0.5);
    expect(character['center_y'], 0.4);
  });

  test('skips incomplete Vibe arrays without fabricating defaults', () async {
    for (final missingKey in [
      'reference_strength_multiple',
      'reference_information_extracted_multiple',
    ]) {
      final metadata = <String, dynamic>{
        'prompt': 'keep this valid field',
        'reference_image_multiple': ['encoded-vibe'],
        'reference_strength_multiple': [0.4],
        'reference_information_extracted_multiple': [0.8],
      }..remove(missingKey);
      final result = await parseImageMetadata(
        _pngWithText([_textChunk('Comment', jsonEncode(metadata))]),
      );
      final current = GenerationParameters(
        model: 'nai-diffusion-4-5-full',
        prompt: 'old prompt',
        width: 832,
        height: 1216,
        vibeReferences: [VibeReference(assetId: 'existing-vibe')],
      );

      expect(result.fields['prompt'], 'keep this valid field');
      expect(result.fields, isNot(contains('vibe_references')));
      expect(
        result.warnings.any((warning) => warning.contains('缺少强度或信息提取数据')),
        isTrue,
      );
      final patched = result.applyTo(
        current,
        selectedFields: {'prompt', 'vibe_references'},
      );
      expect(patched.prompt, 'keep this valid field');
      expect(patched.vibeReferences.single.assetId, 'existing-vibe');
    }
  });

  test(
    'preserves explicitly empty Vibe arrays without companion arrays',
    () async {
      final result = await parseImageMetadata(
        _pngWithText([
          _textChunk('Comment', jsonEncode({'reference_image_multiple': []})),
        ]),
      );

      expect(result.fields, contains('vibe_references'));
      expect(result.fields['vibe_references'], isEmpty);
      expect(
        result.warnings.any((warning) => warning.contains('缺少强度或信息提取数据')),
        isFalse,
      );
    },
  );

  test('reads gzip stealth metadata from alpha and RGB LSB carriers', () async {
    for (final channel in ['alpha', 'rgb']) {
      final png = _pngWithStealth(
        jsonEncode({'prompt': 'from $channel', 'seed': 0}),
        channel: channel,
      );

      final result = await parseImageMetadata(png);

      expect(result.fields['prompt'], 'from $channel');
      expect(result.fields['seed'], 0);
      expect(
        result.source,
        channel == 'alpha' ? 'stealth-alpha' : 'stealth-rgb',
      );
    }
  });

  test(
    'skips RGB stealth fallback for semitransparent decoded pixels',
    () async {
      final png = _pngWithStealth(
        jsonEncode({'prompt': 'do not trust premultiplied RGB bits'}),
        channel: 'rgb',
        semiTransparent: true,
      );

      final result = await parseImageMetadata(png);

      expect(result.fields, isEmpty);
      expect(result.recognized, isFalse);
      expect(
        result.warnings.any((warning) => warning.contains('透明像素')),
        isTrue,
      );
    },
  );

  test(
    'applies only selected present fields and preserves explicitly empty text',
    () async {
      final result = await parseImageMetadata(
        _pngWithText([
          _textChunk('Comment', jsonEncode({'prompt': '', 'seed': 0})),
        ]),
      );
      final current = GenerationParameters(
        model: 'nai-diffusion-4-5-full',
        prompt: 'keep prompt',
        negativePrompt: 'keep negative',
        width: 512,
        height: 512,
        seed: 42,
        steps: 19,
      );

      final patched = result.applyTo(
        current,
        selectedFields: {'prompt', 'seed', 'width', 'negative_prompt'},
      );

      expect(patched.prompt, '');
      expect(patched.seed, 0);
      expect(patched.width, 512);
      expect(patched.negativePrompt, 'keep negative');
      expect(patched.steps, 19);
    },
  );

  test(
    'invalid values and corrupt text CRC do not become draft fields',
    () async {
      final invalid = await parseImageMetadata(
        _pngWithText([
          _textChunk(
            'Comment',
            jsonEncode({'seed': -1, 'steps': 0, 'scale': 99, 'width': 123}),
          ),
        ]),
      );
      expect(invalid.fields, isEmpty);
      expect(invalid.warnings, isNotEmpty);
      final original = GenerationParameters(
        model: 'nai-diffusion-4-5-full',
        prompt: 'preserve',
        width: 832,
        height: 1216,
        steps: 27,
        scale: 4.5,
        seed: 89,
      );
      final unchanged = invalid.applyTo(
        original,
        selectedFields: {'seed', 'steps', 'scale', 'width'},
      );
      expect(unchanged.prompt, 'preserve');
      expect(unchanged.width, 832);
      expect(unchanged.steps, 27);
      expect(unchanged.scale, 4.5);
      expect(unchanged.seed, 89);

      final corrupt = await parseImageMetadata(
        _pngWithText([
          _textChunk('Comment', jsonEncode({'prompt': 'must not apply'})),
        ], corruptTextCrc: true),
      );
      expect(corrupt.recognized, isFalse);
      expect(corrupt.fields, isEmpty);
      expect(
        corrupt.warnings.any((warning) => warning.contains('CRC 校验')),
        isTrue,
      );
    },
  );

  test('bounds compressed text expansion and refuses truncated PNGs', () async {
    final expanded = List<int>.filled(4 * 1024 * 1024 + 1, 0x61);
    final bomb = _pngWithText(
      [_compressedTextChunk('Comment', latin1.decode(expanded))],
      width: 50000,
      height: 50000,
      omitImageData: true,
    );
    final limited = await parseImageMetadata(bomb);
    expect(limited.fields, isEmpty);
    expect(limited.warnings.any((warning) => warning.contains('解压限制')), isTrue);

    final valid = _pngWithText([_textChunk('Comment', '{"prompt":"ok"}')]);
    final truncated = await parseImageMetadata(
      valid.sublist(0, valid.length - 5),
    );
    expect(truncated.recognized, isFalse);
    expect(truncated.warnings, isNotEmpty);
  });

  test('revalidates persisted field maps and accepts JSON numeric forms', () {
    final decodedFields = Map<String, dynamic>.from(
      jsonDecode(
        jsonEncode({
          'model': 'nai-diffusion-4-5-full',
          'prompt': '',
          'negative_prompt': 'keep clear',
          'width': 1024.0,
          'height': 768.0,
          'steps': 30.0,
          'scale': 5,
          'cfg_rescale': 0,
          'seed': 0.0,
          'use_coords': false,
          'characters': [
            {
              'prompt': 'role',
              'center_x': 0,
              'center_y': 0.75,
              'enabled': true,
              'reference_images': [],
            },
          ],
          'vibe_references': [
            {
              'asset_id': '',
              'strength': 1,
              'information_extracted': 0.5,
              'encoded_vibe': 'encoded',
            },
          ],
        }),
      ) as Map,
    );
    final current = GenerationParameters(
      model: 'nai-diffusion-4-5-full',
      prompt: 'keep prompt',
      negativePrompt: 'old negative',
      width: 832,
      height: 1216,
      steps: 20,
      scale: 4.0,
      cfgRescale: 0.2,
      seed: 12,
      useCoords: true,
    );

    final patched = ImageMetadataResult(fields: decodedFields)
        .applyTo(current, selectedFields: decodedFields.keys.toSet());

    expect(patched.prompt, '');
    expect(patched.negativePrompt, 'keep clear');
    expect(patched.width, 1024);
    expect(patched.height, 768);
    expect(patched.steps, 30);
    expect(patched.scale, 5.0);
    expect(patched.cfgRescale, 0.0);
    expect(patched.seed, 0);
    expect(patched.useCoords, isFalse);
    expect(patched.characters.single.centerX, 0.0);
    expect(patched.characters.single.centerY, 0.75);
    expect(patched.vibeReferences.single.strength, 1.0);
    expect(patched.vibeReferences.single.informationExtracted, 0.5);
    expect(patched.vibeReferences.single.hasUnverifiedEncodedVibe, isTrue);
  });

  test('malformed persisted scalars cannot overwrite the current draft', () {
    final result = ImageMetadataResult(
      fields: {
        'model': 'unknown-model',
        'prompt': 42,
        'width': 123,
        'height': 8192.0,
        'steps': 0.0,
        'scale': double.infinity,
        'cfg_rescale': -1,
        'sampler': '  ',
        'noise_schedule': List<int>.filled(3, 1),
        'seed': -1.0,
        'use_coords': 'false',
      },
    );
    final current = GenerationParameters(
      model: 'nai-diffusion-4-5-full',
      prompt: 'preserve prompt',
      width: 832,
      height: 1216,
      steps: 27,
      scale: 4.5,
      cfgRescale: 0.2,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      seed: 89,
      useCoords: true,
    );

    final patched = result.applyTo(
      current,
      selectedFields: result.fields.keys.toSet(),
    );

    expect(patched.toJson(), current.toJson());
  });

  test('invalid nested roles and Vibe references preserve existing values', () {
    final current = GenerationParameters(
      model: 'nai-diffusion-4-5-full',
      prompt: 'keep',
      width: 832,
      height: 1216,
      characters: [GenerationCharacter(prompt: 'existing role')],
      vibeReferences: [VibeReference(assetId: 'local-vibe')],
    );
    final result = ImageMetadataResult(
      fields: {
        'characters': [
          {'prompt': 'would be partial'},
          {'prompt': 99},
        ],
        'vibe_references': [
          {
            'asset_id': 'https://example.invalid/reference',
            'encoded_vibe': 'untrusted',
            'strength': 0.4,
            'information_extracted': 0.8,
          },
        ],
      },
    );

    final patched = result.applyTo(
      current,
      selectedFields: {'characters', 'vibe_references'},
    );

    expect(patched.characters.single.prompt, 'existing role');
    expect(patched.vibeReferences.single.assetId, 'local-vibe');
  });

  test('valid explicit empty role and Vibe arrays clear existing values', () {
    final current = GenerationParameters(
      model: 'nai-diffusion-4-5-full',
      prompt: 'keep',
      width: 832,
      height: 1216,
      characters: [GenerationCharacter(prompt: 'existing role')],
      vibeReferences: [VibeReference(assetId: 'local-vibe')],
    );

    final patched = ImageMetadataResult(
      fields: {'characters': [], 'vibe_references': []},
    ).applyTo(current, selectedFields: {'characters', 'vibe_references'});

    expect(patched.characters, isEmpty);
    expect(patched.vibeReferences, isEmpty);
  });

  test('persisted Vibe scope and character image references are rejected', () {
    final current = GenerationParameters(
      model: 'nai-diffusion-4-5-full',
      prompt: 'keep',
      width: 832,
      height: 1216,
      characters: [GenerationCharacter(prompt: 'existing role')],
      vibeReferences: [VibeReference(assetId: 'local-vibe')],
    );
    final result = ImageMetadataResult(
      fields: {
        'characters': [
          {
            'prompt': 'role with image path',
            'reference_images': [
              {'asset_id': 'C:\\private\\image.png'},
            ],
          },
        ],
        'vibe_references': [
          {
            'asset_id': '',
            'encoded_vibe': 'encoded',
            'strength': 0.4,
            'information_extracted': 0.8,
            'encoded_vibe_scope': {'provider_protocol': 'forged'},
          },
        ],
      },
    );

    final patched = result.applyTo(
      current,
      selectedFields: {'characters', 'vibe_references'},
    );

    expect(patched.characters.single.prompt, 'existing role');
    expect(patched.vibeReferences.single.assetId, 'local-vibe');
  });
}

Uint8List _pngWithText(
  List<List<int>> textChunks, {
  int width = 8,
  int height = 8,
  bool corruptTextCrc = false,
  bool omitImageData = false,
}) {
  final chunks = <List<int>>[];
  final header = ByteData(13)
    ..setUint32(0, width, Endian.big)
    ..setUint32(4, height, Endian.big)
    ..setUint8(8, 8)
    ..setUint8(9, 6)
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  chunks.add(_pngChunk('IHDR', header.buffer.asUint8List()));
  for (var i = 0; i < textChunks.length; i++) {
    final item = textChunks[i];
    final type = latin1.decode(item.sublist(0, 4));
    final data = item.sublist(4);
    chunks.add(_pngChunk(type, data, corruptCrc: corruptTextCrc && i == 0));
  }
  if (!omitImageData) {
    final scanlines = Uint8List(height * (width * 4 + 1));
    for (var y = 0; y < height; y++) {
      final row = y * (width * 4 + 1);
      scanlines[row] = 0;
      for (var x = 0; x < width; x++) {
        final pixel = row + 1 + x * 4;
        scanlines.setRange(pixel, pixel + 4, const [128, 128, 128, 255]);
      }
    }
    chunks.add(_pngChunk('IDAT', const ZLibEncoder().encodeBytes(scanlines)));
  }
  chunks.add(_pngChunk('IEND', const []));
  return Uint8List.fromList([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunks.expand((chunk) => chunk),
  ]);
}

List<int> _textChunk(String keyword, String value) => [
  ...latin1.encode('tEXt'),
  ...latin1.encode(keyword),
  0,
  ...latin1.encode(value),
];

List<int> _internationalTextChunk(String keyword, String value) => [
  ...latin1.encode('iTXt'),
  ...latin1.encode(keyword),
  0,
  0,
  0,
  0,
  0,
  ...utf8.encode(value),
];

List<int> _compressedTextChunk(String keyword, String value) => [
  ...latin1.encode('zTXt'),
  ...latin1.encode(keyword),
  0,
  0,
  ...const ZLibEncoder().encodeBytes(latin1.encode(value)),
];

Uint8List _pngWithStealth(
  String json, {
  required String channel,
  bool semiTransparent = false,
}) {
  final width = channel == 'alpha' ? 80 : 32;
  final height = channel == 'alpha' ? 48 : 24;
  final content = const GZipEncoder().encodeBytes(utf8.encode(json));
  final magic = latin1.encode(
    channel == 'alpha' ? 'stealth_pngcomp' : 'stealth_rgbcomp',
  );
  final bitLength = ByteData(4)..setUint32(0, content.length * 8, Endian.big);
  final payload = <int>[
    ...magic,
    ...bitLength.buffer.asUint8List(),
    ...content,
  ];
  final rgba = Uint8List(width * height * 4);
  for (var i = 0; i < width * height; i++) {
    rgba[i * 4] = 128;
    rgba[i * 4 + 1] = 130;
    rgba[i * 4 + 2] = 132;
    rgba[i * 4 + 3] = channel == 'alpha' || semiTransparent ? 254 : 255;
  }
  final channelCount = channel == 'alpha' ? 1 : 3;
  var bitIndex = 0;
  for (final byte in payload) {
    for (var bit = 7; bit >= 0; bit--) {
      final pixelIndex = bitIndex ~/ channelCount;
      final component = bitIndex % channelCount;
      final x = pixelIndex ~/ height;
      final y = pixelIndex % height;
      final pixelOffset = (y * width + x) * 4;
      final channelOffset = channel == 'alpha' ? 3 : component;
      rgba[pixelOffset + channelOffset] =
          (rgba[pixelOffset + channelOffset] & 0xfe) | ((byte >> bit) & 1);
      bitIndex++;
    }
  }

  final scanlines = Uint8List(height * (width * 4 + 1));
  for (var y = 0; y < height; y++) {
    final scanline = y * (width * 4 + 1);
    scanlines[scanline] = 0;
    scanlines.setRange(
      scanline + 1,
      scanline + width * 4 + 1,
      rgba,
      y * width * 4,
    );
  }
  final header = ByteData(13)
    ..setUint32(0, width, Endian.big)
    ..setUint32(4, height, Endian.big)
    ..setUint8(8, 8)
    ..setUint8(9, 6)
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  final chunks = [
    _pngChunk('IHDR', header.buffer.asUint8List()),
    _pngChunk('IDAT', const ZLibEncoder().encodeBytes(scanlines)),
    _pngChunk('IEND', const []),
  ];
  return Uint8List.fromList([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunks.expand((chunk) => chunk),
  ]);
}

List<int> _pngChunk(String type, List<int> data, {bool corruptCrc = false}) {
  final header = ByteData(4)..setUint32(0, data.length, Endian.big);
  final typeBytes = latin1.encode(type);
  var checksum = _crc32([...typeBytes, ...data]);
  if (corruptCrc) checksum ^= 0xffffffff;
  final crc = ByteData(4)..setUint32(0, checksum, Endian.big);
  return [
    ...header.buffer.asUint8List(),
    ...typeBytes,
    ...data,
    ...crc.buffer.asUint8List(),
  ];
}

int _crc32(List<int> bytes) {
  var crc = 0xffffffff;
  for (final byte in bytes) {
    crc ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xedb88320 : crc >> 1;
    }
  }
  return crc ^ 0xffffffff;
}
