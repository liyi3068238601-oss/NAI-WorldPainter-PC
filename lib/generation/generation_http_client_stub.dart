import 'package:http/http.dart' as http;

// Browsers supply their own User-Agent and forbid changing it in fetch.
http.Client createGenerationHttpClient() => http.Client();
