import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../generation/service_connection.dart';
import '../security/credential_vault.dart';

Future<ServiceConnection?> showConnectionDialog(
  BuildContext context, {
  required ServiceConnection connection,
  required CredentialVault vault,
}) => showDialog<ServiceConnection>(
  context: context,
  builder: (_) => _ConnectionDialog(connection: connection, vault: vault),
);

class _ConnectionDialog extends StatefulWidget {
  const _ConnectionDialog({required this.connection, required this.vault});
  final ServiceConnection connection;
  final CredentialVault vault;
  @override
  State<_ConnectionDialog> createState() => _ConnectionDialogState();
}

class _ConnectionDialogState extends State<_ConnectionDialog> {
  late final url = TextEditingController(text: widget.connection.baseUrl);
  final secret = TextEditingController();
  String status = '正在检查凭据…';
  bool busy = false;
  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    try {
      final value = await widget.connection.readSecret(widget.vault);
      if (mounted && url.text == widget.connection.baseUrl) {
        setState(() => status = value == null ? '尚未保存凭据' : '已保存凭据；留空即可保留');
      }
    } catch (_) {
      if (mounted) setState(() => status = '请设置服务地址和凭据');
    }
  }

  @override
  void dispose() {
    url.dispose();
    secret.dispose();
    super.dispose();
  }

  Future<void> _save({bool remove = false}) async {
    setState(() => busy = true);
    try {
      final next = ServiceConnection(
        protocol: widget.connection.protocol,
        baseUrl: url.text,
      );
      next.uri;
      if (remove) {
        await next.deleteSecret(widget.vault);
      } else if (secret.text.trim().isNotEmpty) {
        await next.saveSecret(widget.vault, secret.text);
      }
      if (!mounted) return;
      secret.clear();
      Navigator.pop(context, next);
    } on FormatException catch (e) {
      if (mounted) setState(() => status = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => status = '无法保存凭据，请检查 Windows 登录会话后重试。');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text('${widget.connection.label} · 接入设置'),
    content: SizedBox(
      width: 470,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              kIsWeb
                  ? '浏览器凭据仅在本次页面会话保留。Windows 客户端使用凭据管理器保存。'
                  : '凭据由 Windows 凭据管理器保护，按渠道和地址隔离保存。',
            ),
            const SizedBox(height: 20),
            TextField(
              controller: url,
              onChanged: (_) =>
                  setState(() => status = '地址已改变；此地址的凭据将在保存或生成时检查。'),
              enabled: !busy && widget.connection.protocol != 'official',
              decoration: const InputDecoration(
                labelText: '服务根地址',
                hintText: 'https://…',
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: secret,
              enabled: !busy,
              obscureText: true,
              enableSuggestions: false,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: widget.connection.protocol == 'official'
                    ? 'NovelAI Persistent API Token'
                    : '网关 API Key',
                hintText: '输入新凭据；留空保留此地址已有凭据',
              ),
            ),
            const SizedBox(height: 12),
            Text(status, style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 8),
            const Text(
              '保存配置不会发起生成请求。切换服务地址后需单独配置该地址的凭据。',
              style: TextStyle(fontSize: 11),
            ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: busy ? null : () => _save(remove: true),
        child: const Text('删除此地址凭据'),
      ),
      TextButton(
        onPressed: busy ? null : () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(onPressed: busy ? null : _save, child: const Text('保存配置')),
    ],
  );
}
