#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <flutter/flutter_view_controller.h>

#include <memory>

#include "win32_window.h"
#include "credential_channel.h"
#include "files_channel.h"

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project,
                         bool storage_probe);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;

 private:
  // The project to run.
  flutter::DartProject project_;
  std::unique_ptr<CredentialChannel> credential_channel_;
  std::unique_ptr<FilesChannel> files_channel_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // Native window lifecycle channel shared with Dart.
  std::unique_ptr<
      flutter::MethodChannel<flutter::EncodableValue>> window_channel_;

  // Probe mode must stay hidden and is the only mode that exposes probeClose.
  bool storage_probe_ = false;
  bool show_window_ = true;

  // A close is deferred until Dart acknowledges that persistence has finished.
  bool close_request_pending_ = false;
  bool close_allowed_ = false;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
