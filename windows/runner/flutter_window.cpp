#include "flutter_window.h"

#include <flutter/method_result_functions.h>
#include <flutter/standard_method_codec.h>

#include <optional>

#include "flutter/generated_plugin_registrant.h"

namespace {

constexpr char kWindowChannelName[] = "worldpainter/window";
constexpr UINT kCloseAcceptedMessage = WM_APP + 1;
constexpr UINT kCloseRejectedMessage = WM_APP + 2;

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project,
                             bool storage_probe)
    : project_(project),
      storage_probe_(storage_probe),
      show_window_(!storage_probe) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());

  window_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), kWindowChannelName,
          &flutter::StandardMethodCodec::GetInstance());
  window_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        if (call.method_name() == "probeClose" && storage_probe_) {
          HWND window = GetHandle();
          if (window != nullptr && PostMessage(window, WM_CLOSE, 0, 0)) {
            result->Success(flutter::EncodableValue(true));
          } else {
            result->Error("window_unavailable",
                          "Could not post the probe close request.");
          }
          return;
        }
        result->NotImplemented();
      });

  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    if (show_window_) {
      this->Show();
    }
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (window_channel_) {
    window_channel_->SetMethodCallHandler(nullptr);
    window_channel_.reset();
  }

  if (flutter_controller_) {
    flutter_controller_.reset();
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  if (message == kCloseAcceptedMessage) {
    close_request_pending_ = false;
    close_allowed_ = true;
    if (!PostMessage(hwnd, WM_CLOSE, 0, 0)) {
      close_allowed_ = false;
    }
    return 0;
  }

  if (message == kCloseRejectedMessage) {
    close_request_pending_ = false;
    close_allowed_ = false;
    return 0;
  }

  if (message == WM_CLOSE) {
    if (close_allowed_) {
      close_allowed_ = false;
      return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
    }

    if (close_request_pending_ || !window_channel_) {
      return 0;
    }

    close_request_pending_ = true;
    const auto post_close_result = [hwnd](bool accepted) {
      const UINT response_message =
          accepted ? kCloseAcceptedMessage : kCloseRejectedMessage;
      PostMessage(hwnd, response_message, 0, 0);
    };
    window_channel_->InvokeMethod(
        "requestClose", nullptr,
        std::make_unique<flutter::MethodResultFunctions<
            flutter::EncodableValue>>(
            [post_close_result](const flutter::EncodableValue* value) {
              const bool accepted =
                  value != nullptr && std::holds_alternative<bool>(*value) &&
                  std::get<bool>(*value);
              post_close_result(accepted);
            },
            [post_close_result](const std::string&, const std::string&,
                                const flutter::EncodableValue*) {
              post_close_result(false);
            },
            [post_close_result]() { post_close_result(false); }));
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
