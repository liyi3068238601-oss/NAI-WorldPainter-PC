# Windows native security and file channels

This note describes the standalone runner components added for Windows. The
FlutterWindow integration remains the application integrator's responsibility.

## Credential vault

`lib/security/credential_vault.dart` exposes `CredentialVault` and
`createCredentialVault()`:

```dart
final vault = createCredentialVault();
await vault.save(
  provider: 'novelai',
  key: 'official_token',
  secret: token,
);
final token = await vault.read(provider: 'novelai', key: 'official_token');
await vault.delete(provider: 'novelai', key: 'official_token');
```

The provider and key are stable ASCII identifiers, up to 64 characters, using
letters, digits, `.`, `_`, or `-`; each starts with a letter or digit. They
must not be user-facing labels. Windows validates both fields again and builds
the target name internally as
`WorldPainter/credential/v1/<provider>/<key>`. The caller cannot select a
Credential Manager target outside this application namespace. A missing read
returns null; delete is idempotent. Secrets must be non-empty UTF-8 and fit
Credential Manager's 2,560-byte generic credential blob limit.

The Windows implementation uses generic credentials in the current Windows
user's Credential Manager with `CRED_PERSIST_LOCAL_MACHINE`. Secret bytes are
not written to the application's SQLite database, ordinary files, or logs.
They exist in process memory while the app uses them; this API protects stored
credentials at rest and does not prevent memory inspection by code running as
the user. Native errors are returned as fixed generic messages and never
include the supplied secret or Windows error text.

Web uses `SessionMemoryCredentialVault`. Its values live only in the current
page's memory and disappear on reload or close. This is not persistent secure
storage, and the web preview must not describe it as protected persistence.

Windows native class: `CredentialChannel` in
`windows/runner/credential_channel.h/.cpp`. Install it after the Flutter engine
is ready:

```cpp
credential_channel_ = std::make_unique<CredentialChannel>(
    flutter_controller_->engine()->messenger());
```

Keep the owning `std::unique_ptr` alive for the runner lifetime and reset it
before destroying the Flutter controller. Add `credential_channel.cpp` to the
runner executable sources and link `Advapi32.lib` in
`windows/runner/CMakeLists.txt`. This source does not edit or depend on
`flutter_window.cpp`.

Microsoft API references:

- [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew) creates or replaces the current user's credential.
- [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) reads it; the returned allocation is released with [CredFree](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credfree).
- [CredDeleteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creddeletew) deletes it.
- [CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) defines generic credential blobs and the local-machine persistence setting.

## Hidden Windows credential probe

`runWindowsCredentialProbe(args)` is an IO-only Dart entry point for the
integrator to call before the normal app. It recognizes
`--credential-probe`, `--phase=write|read`, and `--run-key=<id>`. Use it along
with the runner's hidden-probe flag (`--storage-probe`) so no application
window appears. The probe only uses the fixed synthetic value
`synthetic-worldpainter-credential-probe-v1`.

Run the two phases as separate process launches with the same fresh lowercase
GUID run key:

```powershell
$runKey = [guid]::NewGuid().ToString('N').ToLowerInvariant()
flutter run -d windows -- --storage-probe --credential-probe --phase=write --run-key=$runKey
flutter run -d windows -- --storage-probe --credential-probe --phase=read --run-key=$runKey
```

The write phase saves and reads back the synthetic value, leaving it for the
second process. The read phase checks the same value, deletes it, and confirms
that a subsequent read returns null. Each process prints only
`CREDENTIAL_PROBE phase=<phase> result=PASS` or a fixed failure code. Neither
the secret nor the run key is included in output. The read phase attempts
cleanup even when verification fails.

The integrator should:

1. Treat `--credential-probe` as a hidden runner startup mode in `main.cpp`.
2. Call `runWindowsCredentialProbe(args)` before the regular app and before
   `runStorageProbe(args)` so it takes precedence when both flags are present.
3. Keep the existing `worldpainter/window` `probeClose` handler enabled for
   this hidden mode. The helper installs an accepting lifecycle callback,
   starts an empty Flutter view, requests `probeClose`, and then returns.
4. Verify both processes exit and report PASS. Do not run the probe with a real
   provider or secret.

The probe API intentionally uses the existing window close handshake, so the
native runner must set its hidden-window flag for `--credential-probe` as well
as `--storage-probe`.

## Windows image picker channel

`FilesChannel` in `windows/runner/files_channel.h/.cpp` handles one no-argument
method, `worldpainter/files.pickImage`. The Windows open dialog filters PNG,
JPEG, WebP, and GIF; cancel returns null. A selected file must be non-empty,
match one of those file signatures, and be at most 30 MiB. Success returns
`Uint8List` bytes and never returns the selected path. Picker and read errors
use fixed messages.

Install and retain the channel using the same runner lifetime pattern:

```cpp
files_channel_ = std::make_unique<FilesChannel>(
    flutter_controller_->engine()->messenger(), GetHandle());
```

Add `files_channel.cpp` to the runner executable sources and link
`Comdlg32.lib`. The native dialog appears only when the Flutter UI explicitly
invokes `pickImage`; the hidden credential probe does not invoke it.

Microsoft's [GetOpenFileNameW documentation](https://learn.microsoft.com/en-us/windows/win32/api/commdlg/nf-commdlg-getopenfilenamew)
notes that the older common dialog API has been superseded by Common Item
Dialog on modern Windows. This implementation follows the requested
`GetOpenFileNameW` interface; replacing it with `IFileOpenDialog` can be a
separate runner change if the UI later needs newer shell behavior.
