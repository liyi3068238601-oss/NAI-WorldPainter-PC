import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../security/credential_vault.dart';

/// Public connection settings only. A credential never belongs in this JSON.
class ServiceConnection {
  const ServiceConnection({required this.protocol, required this.baseUrl});
  final String protocol;
  final String baseUrl;
  static const labels = {
    'official': 'NovelAI 官方',
    'gateway7877': '7877 网关',
    'ikun': 'ikun 网关',
  };
  static const officialUrl = 'https://image.novelai.net';
  static const defaults = {
    'official': officialUrl,
    'gateway7877': '',
    'ikun': 'https://novelai.ikun114.top',
  };

  String get label => labels[protocol] ?? protocol;
  Uri get uri {
    final parsed = Uri.tryParse(baseUrl.trim());
    if (!labels.containsKey(protocol) ||
        parsed == null ||
        !parsed.hasAuthority ||
        parsed.userInfo.isNotEmpty ||
        parsed.hasQuery ||
        parsed.hasFragment ||
        !(parsed.scheme == 'https' ||
            (parsed.scheme == 'http' &&
                ['localhost', '127.0.0.1', '::1'].contains(parsed.host)))) {
      throw const FormatException('请输入 HTTPS 服务根地址；本地测试可使用回环 HTTP 地址。');
    }
    final normalized = parsed.replace(
      path: parsed.path.replaceAll(RegExp(r'/+$'), ''),
    );
    if (protocol == 'official' && normalized.toString() != officialUrl) {
      throw const FormatException('官方渠道固定使用 NovelAI 图像服务地址。');
    }
    return normalized;
  }

  String get credentialKey =>
      sha256.convert(utf8.encode(uri.toString())).toString();
  Future<String?> readSecret(CredentialVault vault) =>
      vault.read(provider: protocol, key: credentialKey);
  Future<void> saveSecret(CredentialVault vault, String secret) =>
      vault.save(provider: protocol, key: credentialKey, secret: secret.trim());
  Future<void> deleteSecret(CredentialVault vault) =>
      vault.delete(provider: protocol, key: credentialKey);
  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'baseUrl': uri.toString(),
  };
}
