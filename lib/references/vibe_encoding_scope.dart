import 'dart:convert';

import 'package:crypto/crypto.dart';

/// Normalizes the endpoint identity used for Vibe encodings.
///
/// Trailing slashes, host casing, and explicit default ports do not create a
/// second cache entry. A non-default port or a gateway path remains significant.
String normalizeVibeEndpoint(Uri endpoint) {
  final scheme = endpoint.scheme.toLowerCase();
  if (!endpoint.isAbsolute ||
      endpoint.host.isEmpty ||
      (scheme != 'https' && scheme != 'http') ||
      endpoint.userInfo.isNotEmpty ||
      endpoint.hasQuery ||
      endpoint.hasFragment) {
    throw const FormatException('Vibe 服务地址无效。');
  }
  final port = switch ((scheme, endpoint.port)) {
    ('https', 443) || ('http', 80) => null,
    (_, final value) => value,
  };
  var path = endpoint.path.replaceAll(RegExp(r'/+$'), '');
  if (path == '/') path = '';
  return Uri(
    scheme: scheme,
    host: endpoint.host.toLowerCase(),
    port: port,
    path: path,
  ).toString();
}

/// Gives aliases used by the 7877 gateway the exact model ID sent on the wire.
String normalizeVibeModel(String model, String providerProtocol) {
  final trimmed = model.trim();
  if (providerProtocol != 'gateway7877') return trimmed;
  return switch (trimmed.toLowerCase()) {
    'nai-v4.5-full' || 'nai-v4-5-full' => 'nai-diffusion-4-5-full',
    'nai-v4.5-curated' || 'nai-v4-5-curated' => 'nai-diffusion-4-5-curated',
    'nai-v4-full' => 'nai-diffusion-4-full',
    'nai-v4-curated' => 'nai-diffusion-4-curated',
    'nai-v3' => 'nai-diffusion-3',
    'nai-v3-furry' || 'nai-v3-furry-limit' => 'nai-diffusion-3-furry',
    _ => trimmed,
  };
}

/// Identifies the exact input and provider context that produced one encoding.
/// Strength is intentionally excluded because it is a generation-time control.
class VibeEncodingScope {
  VibeEncodingScope({
    required this.sourceAssetRef,
    required this.sourceSha256,
    required String model,
    required this.providerProtocol,
    required Uri endpoint,
    required this.informationExtracted,
  }) : model = normalizeVibeModel(model, providerProtocol),
       endpoint = normalizeVibeEndpoint(endpoint) {
    _validate();
  }

  VibeEncodingScope._normalized({
    required this.sourceAssetRef,
    required this.sourceSha256,
    required this.model,
    required this.providerProtocol,
    required this.endpoint,
    required this.informationExtracted,
  }) {
    _validate();
  }

  /// Empty source reference and a null digest are reserved for user-confirmed
  /// imported encodings whose original image is unavailable.
  final String sourceAssetRef;
  final String? sourceSha256;
  final String model;
  final String providerProtocol;
  final String endpoint;
  final double informationExtracted;

  bool get hasSource => sourceAssetRef.isNotEmpty && sourceSha256 != null;

  String get cacheKey => sha256
      .convert(
        utf8.encode(
          jsonEncode([
            sourceAssetRef,
            sourceSha256,
            model,
            providerProtocol,
            endpoint,
            informationExtracted,
          ]),
        ),
      )
      .toString();

  bool matchesProvider({
    required String model,
    required String providerProtocol,
    required Uri endpoint,
    required double informationExtracted,
  }) {
    try {
      return this.model == normalizeVibeModel(model, providerProtocol) &&
          this.providerProtocol == providerProtocol &&
          this.endpoint == normalizeVibeEndpoint(endpoint) &&
          this.informationExtracted == informationExtracted;
    } on FormatException {
      return false;
    }
  }

  bool matches({
    required String sourceAssetRef,
    required String? sourceSha256,
    required String model,
    required String providerProtocol,
    required Uri endpoint,
    required double informationExtracted,
  }) =>
      this.sourceAssetRef == sourceAssetRef &&
      this.sourceSha256 == sourceSha256 &&
      matchesProvider(
        model: model,
        providerProtocol: providerProtocol,
        endpoint: endpoint,
        informationExtracted: informationExtracted,
      );

  Map<String, Object?> toJson() => <String, Object?>{
    'source_asset_ref': sourceAssetRef,
    'source_sha256': sourceSha256,
    'model': model,
    'provider_protocol': providerProtocol,
    'endpoint': endpoint,
    'information_extracted': informationExtracted,
  };

  factory VibeEncodingScope.fromJson(Map<String, dynamic> json) {
    final endpointValue = json['endpoint'];
    if (endpointValue is! String) {
      throw const FormatException('Vibe 编码缺少服务地址。');
    }
    final sourceRef = json['source_asset_ref'];
    final sourceSha = json['source_sha256'];
    final model = json['model'];
    final protocol = json['provider_protocol'];
    final information = json['information_extracted'];
    if (sourceRef is! String ||
        (sourceSha != null && sourceSha is! String) ||
        model is! String ||
        protocol is! String ||
        information is! num) {
      throw const FormatException('Vibe 编码范围信息不完整。');
    }
    final parsedEndpoint = Uri.tryParse(endpointValue);
    if (parsedEndpoint == null) {
      throw const FormatException('Vibe 编码服务地址无效。');
    }
    final normalizedEndpoint = normalizeVibeEndpoint(parsedEndpoint);
    final normalizedModel = normalizeVibeModel(model, protocol);
    return VibeEncodingScope._normalized(
      sourceAssetRef: sourceRef,
      sourceSha256: sourceSha as String?,
      model: normalizedModel,
      providerProtocol: protocol,
      endpoint: normalizedEndpoint,
      informationExtracted: information.toDouble(),
    );
  }

  void _validate() {
    if (model.isEmpty ||
        providerProtocol.isEmpty ||
        !informationExtracted.isFinite ||
        informationExtracted < 0 ||
        informationExtracted > 1 ||
        (sourceAssetRef.isEmpty && sourceSha256 != null) ||
        (sourceAssetRef.isNotEmpty &&
            (sourceSha256 == null ||
                !RegExp(r'^[0-9a-f]{64}$').hasMatch(sourceSha256!)))) {
      throw const FormatException('Vibe 编码范围信息无效。');
    }
  }
}
