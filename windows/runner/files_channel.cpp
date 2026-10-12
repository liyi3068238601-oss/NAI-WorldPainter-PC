#include "files_channel.h"

#include <windows.h>
#include <commdlg.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

#include <flutter/standard_method_codec.h>

namespace {

constexpr char kChannelName[] = "worldpainter/files";
constexpr uint64_t kMaxImageBytes = 30ULL * 1024ULL * 1024ULL;
constexpr DWORD kReadChunkBytes = 1024 * 1024;

class FileHandle {
 public:
  explicit FileHandle(HANDLE value) : value_(value) {}
  ~FileHandle() {
    if (value_ != INVALID_HANDLE_VALUE) {
      CloseHandle(value_);
    }
  }

  FileHandle(const FileHandle&) = delete;
  FileHandle& operator=(const FileHandle&) = delete;

  HANDLE get() const { return value_; }

 private:
  HANDLE value_;
};

bool HasSignature(const std::vector<uint8_t>& bytes) {
  static constexpr std::array<uint8_t, 8> kPngSignature = {
      0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
  if (bytes.size() >= kPngSignature.size() &&
      std::equal(kPngSignature.begin(), kPngSignature.end(), bytes.begin())) {
    return true;
  }
  if (bytes.size() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return true;
  }
  if (bytes.size() >= 12 && bytes[0] == 'R' && bytes[1] == 'I' &&
      bytes[2] == 'F' && bytes[3] == 'F' && bytes[8] == 'W' &&
      bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') {
    return true;
  }
  return bytes.size() >= 6 && bytes[0] == 'G' && bytes[1] == 'I' &&
         bytes[2] == 'F' && bytes[3] == '8' &&
         (bytes[4] == '7' || bytes[4] == '9') && bytes[5] == 'a';
}

void ReturnError(
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result,
    const char* code, const char* message) {
  result->Error(code, message);
}

bool HasNoArguments(const flutter::MethodCall<flutter::EncodableValue>& call) {
  const auto* arguments = call.arguments();
  return arguments == nullptr ||
         std::holds_alternative<std::monostate>(*arguments);
}

void HandlePickImage(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result,
    HWND owner) {
  if (!HasNoArguments(call)) {
    ReturnError(std::move(result), "invalid_arguments",
                "Image picker request is invalid.");
    return;
  }

  std::array<wchar_t, 32768> selected_path{};
  static constexpr wchar_t kImageFilter[] =
      L"Image files (*.png;*.jpg;*.jpeg;*.webp;*.gif)\0"
      L"*.png;*.jpg;*.jpeg;*.webp;*.gif\0"
      L"All files (*.*)\0*.*\0\0";
  OPENFILENAMEW dialog{};
  dialog.lStructSize = sizeof(dialog);
  dialog.hwndOwner = owner;
  dialog.lpstrFilter = kImageFilter;
  dialog.nFilterIndex = 1;
  dialog.lpstrFile = selected_path.data();
  dialog.nMaxFile = static_cast<DWORD>(selected_path.size());
  dialog.lpstrTitle = L"Select an image";
  dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER |
                 OFN_HIDEREADONLY;
  if (!GetOpenFileNameW(&dialog)) {
    if (CommDlgExtendedError() == 0) {
      result->Success(flutter::EncodableValue());
    } else {
      ReturnError(std::move(result), "file_picker_failed",
                  "The image picker could not be opened.");
    }
    return;
  }

  FileHandle file(CreateFileW(selected_path.data(), GENERIC_READ, FILE_SHARE_READ,
                              nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
                              nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) {
    ReturnError(std::move(result), "image_read_failed",
                "The selected image could not be read.");
    return;
  }

  LARGE_INTEGER file_size{};
  if (!GetFileSizeEx(file.get(), &file_size) || file_size.QuadPart <= 0) {
    ReturnError(std::move(result), "image_read_failed",
                "The selected image could not be read.");
    return;
  }
  if (static_cast<uint64_t>(file_size.QuadPart) > kMaxImageBytes) {
    ReturnError(std::move(result), "image_too_large",
                "The selected image exceeds 30 MiB.");
    return;
  }

  std::vector<uint8_t> bytes(static_cast<size_t>(file_size.QuadPart));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const DWORD request_size = static_cast<DWORD>(
        std::min<size_t>(kReadChunkBytes, bytes.size() - offset));
    DWORD bytes_read = 0;
    if (!ReadFile(file.get(), bytes.data() + offset, request_size, &bytes_read,
                  nullptr) ||
        bytes_read == 0) {
      ReturnError(std::move(result), "image_read_failed",
                  "The selected image could not be read.");
      return;
    }
    offset += bytes_read;
  }

  LARGE_INTEGER final_file_size{};
  if (!GetFileSizeEx(file.get(), &final_file_size) ||
      final_file_size.QuadPart != file_size.QuadPart) {
    ReturnError(std::move(result), "image_read_failed",
                "The selected image could not be read.");
    return;
  }

  if (!HasSignature(bytes)) {
    ReturnError(std::move(result), "unsupported_image",
                "Select a PNG, JPEG, WebP, or GIF image.");
    return;
  }

  result->Success(flutter::EncodableValue(std::move(bytes)));
}

}  // namespace

FilesChannel::FilesChannel(flutter::BinaryMessenger* messenger, HWND owner)
    : channel_(std::make_unique<
          flutter::MethodChannel<flutter::EncodableValue>>(
          messenger, kChannelName,
          &flutter::StandardMethodCodec::GetInstance())) {
  channel_->SetMethodCallHandler(
      [owner](const flutter::MethodCall<flutter::EncodableValue>& call,
              std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                  result) {
        if (call.method_name() != "pickImage") {
          result->NotImplemented();
          return;
        }
        HandlePickImage(call, std::move(result), owner);
      });
}

FilesChannel::~FilesChannel() {
  if (channel_ != nullptr) {
    channel_->SetMethodCallHandler(nullptr);
  }
}
