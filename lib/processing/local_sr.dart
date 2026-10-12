import 'local_sr_contract.dart';
import 'local_sr_stub.dart' if (dart.library.io) 'local_sr_io.dart' as platform;

export 'local_sr_contract.dart';

/// Creates the platform implementation. Windows is the only platform with a
/// configured native backend; other IO platforms return an unavailable stub.
LocalSuperResolution createLocalSuperResolution() =>
    platform.createLocalSuperResolution();
