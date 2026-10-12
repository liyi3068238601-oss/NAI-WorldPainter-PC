import 'dart:io';

/// Returns true only when every address currently resolved for [host] is
/// globally routable. This is a best-effort SSRF guard; HTTP clients resolve
/// the hostname again when opening the connection.
Future<bool> isPublicInternetHost(String host) async {
  final literal = InternetAddress.tryParse(host);
  if (literal != null) return _isPublicAddress(literal);
  try {
    final addresses = await InternetAddress.lookup(host);
    return addresses.isNotEmpty && addresses.every(_isPublicAddress);
  } on SocketException {
    return false;
  }
}

bool _isPublicAddress(InternetAddress address) {
  final bytes = address.rawAddress;
  if (address.type == InternetAddressType.IPv4 && bytes.length == 4) {
    final first = bytes[0];
    final second = bytes[1];
    final third = bytes[2];
    if (first == 0 ||
        first == 10 ||
        first == 127 ||
        first >= 224 ||
        (first == 100 && second >= 64 && second <= 127) ||
        (first == 169 && second == 254) ||
        (first == 172 && second >= 16 && second <= 31) ||
        (first == 192 && second == 168) ||
        (first == 192 && second == 0 && third == 0) ||
        (first == 192 && second == 0 && third == 2) ||
        (first == 192 && second == 88 && third == 99) ||
        (first == 198 && second == 18) ||
        (first == 198 && second == 19) ||
        (first == 198 && second == 51 && third == 100) ||
        (first == 203 && second == 0 && third == 113)) {
      return false;
    }
    return true;
  }
  if (address.type != InternetAddressType.IPv6 || bytes.length != 16) {
    return false;
  }
  final globalUnicast = bytes[0] & 0xe0 == 0x20;
  final documentation =
      (bytes[0] == 0x20 &&
          bytes[1] == 0x01 &&
          bytes[2] == 0x0d &&
          bytes[3] == 0xb8) ||
      (bytes[0] == 0x3f &&
          bytes[1] == 0xff &&
          bytes[2] == 0x00 &&
          bytes[3] < 0x10);
  final specialUse =
      (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x00) ||
      (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x01) ||
      (bytes[0] == 0x20 && bytes[1] == 0x02);
  return globalUnicast && !documentation && !specialUse;
}
