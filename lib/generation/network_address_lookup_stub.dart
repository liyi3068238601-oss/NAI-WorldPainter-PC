/// Browser builds cannot inspect DNS results. Literal IPs are checked here;
/// hostnames are accepted and remain subject to the browser's network policy.
Future<bool> isPublicInternetHost(String host) async {
  if (host.contains(':')) return false;
  if (!RegExp(r'^\d{1,3}(?:\.\d{1,3}){3}$').hasMatch(host)) return true;
  final octets = host.split('.');
  final bytes = octets.map(int.tryParse).toList();
  if (bytes.any((byte) => byte == null || byte < 0 || byte > 255)) {
    return false;
  }
  final first = bytes[0]!;
  final second = bytes[1]!;
  final third = bytes[2]!;
  return !(first == 0 ||
      first == 10 ||
      first == 127 ||
      first >= 224 ||
      (first == 100 && second >= 64 && second <= 127) ||
      (first == 169 && second == 254) ||
      (first == 172 && second >= 16 && second <= 31) ||
      (first == 192 && second == 168) ||
      (first == 192 && second == 0 && (third == 0 || third == 2)) ||
      (first == 192 && second == 88 && third == 99) ||
      (first == 198 && (second == 18 || second == 19)) ||
      (first == 198 && second == 51 && third == 100) ||
      (first == 203 && second == 0 && third == 113));
}
