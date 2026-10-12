import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

http.Client createGenerationHttpClient() => IOClient(
  HttpClient()
    ..userAgent = 'WorldPainter-PC/0.1'
    ..findProxy = HttpClient.findProxyFromEnvironment,
);
