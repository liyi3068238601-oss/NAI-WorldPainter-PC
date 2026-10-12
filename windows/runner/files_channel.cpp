#include "files_channel.h"

#include <windows.h>
#include <commdlg.h>
#include <objbase.h>
#include <shobjidl.h>

#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cwctype>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <flutter/standard_method_codec.h>

namespace {

constexpr char kChannelName[] = "worldpainter/files";
constexpr uint64_t kMaxImageBytes = 30ULL * 1024ULL * 1024ULL;
constexpr uint64_t kMaxExportBytes = 64ULL * 1024ULL * 1024ULL;
constexpr DWORD kReadChunkBytes = 1024 * 1024;

constexpr std::array<uint8_t, 8> kPngSignature = {
    0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};

bool HasPngExtension(const std::wstring& value) {
  if (value.size() < 4) return false;
  return std::towlower(value[value.size() - 4]) == L'.' &&
         std::towlower(value[value.size() - 3]) == L'p' &&
         std::towlower(value[value.size() - 2]) == L'n' &&
         std::towlower(value[value.size() - 1]) == L'g';
}

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

bool IsPng(const std::vector<uint8_t>& bytes) {
  return bytes.size() >= kPngSignature.size() &&
         std::equal(kPngSignature.begin(), kPngSignature.end(), bytes.begin());
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

const flutter::EncodableValue* FindArgument(
    const flutter::EncodableMap& arguments, const char* key) {
  const auto iterator =
      arguments.find(flutter::EncodableValue(std::string(key)));
  return iterator == arguments.end() ? nullptr : &iterator->second;
}

bool Utf8ToWide(const std::string& value, std::wstring* result) {
  if (value.empty() || value.size() > 4096) return false;
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return false;
  result->resize(static_cast<size_t>(length));
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                             static_cast<int>(value.size()), result->data(),
                             length) == length;
}

bool IsReservedDeviceName(const std::wstring& name) {
  const auto dot = name.find(L'.');
  std::wstring base = name.substr(0, dot);
  std::transform(base.begin(), base.end(), base.begin(),
                 [](wchar_t character) { return std::towupper(character); });
  if (base == L"CON" || base == L"PRN" || base == L"AUX" || base == L"NUL") {
    return true;
  }
  if (base.size() == 4 &&
      (base.compare(0, 3, L"COM") == 0 || base.compare(0, 3, L"LPT") == 0) &&
      base[3] >= L'1' && base[3] <= L'9') {
    return true;
  }
  return false;
}

std::wstring SanitizePngName(std::wstring name) {
  for (auto& character : name) {
    if (character < 32 || character == L'<' || character == L'>' ||
        character == L':' || character == L'"' || character == L'/' ||
        character == L'\\' || character == L'|' || character == L'?' ||
        character == L'*') {
      character = L'_';
    }
  }
  while (!name.empty() && (name.back() == L' ' || name.back() == L'.')) {
    name.pop_back();
  }
  if (HasPngExtension(name)) {
    name.resize(name.size() - 4);
  } else if (!name.empty()) {
    const auto dot = name.find_last_of(L'.');
    if (dot != std::wstring::npos && dot > 0) name.resize(dot);
  }
  while (!name.empty() && (name.back() == L' ' || name.back() == L'.')) {
    name.pop_back();
  }
  if (name.empty()) name = L"绘世-结果";
  if (name.size() > 140) name.resize(140);
  if (IsReservedDeviceName(name)) name.insert(name.begin(), L'_');
  return name + L".png";
}

bool WriteAndPublishPng(const std::wstring& destination,
                        const std::vector<uint8_t>& bytes) {
  std::wstring temporary_path;
  HANDLE temporary_handle = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 8; ++attempt) {
    GUID identifier{};
    if (FAILED(CoCreateGuid(&identifier))) return false;
    wchar_t guid_text[40]{};
    if (StringFromGUID2(identifier, guid_text, ARRAYSIZE(guid_text)) == 0) {
      return false;
    }
    temporary_path = destination + L"." +
                     std::wstring(guid_text + 1, guid_text + 37) + L".tmp";
    temporary_handle = CreateFileW(
        temporary_path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (temporary_handle != INVALID_HANDLE_VALUE) break;
    const DWORD error = GetLastError();
    if (error != ERROR_FILE_EXISTS && error != ERROR_ALREADY_EXISTS) {
      return false;
    }
  }
  if (temporary_handle == INVALID_HANDLE_VALUE) return false;

  bool write_succeeded = true;
  {
    FileHandle file(temporary_handle);
    size_t offset = 0;
    while (offset < bytes.size()) {
      const DWORD request_size = static_cast<DWORD>(
          std::min<size_t>(kReadChunkBytes, bytes.size() - offset));
      DWORD bytes_written = 0;
      if (!WriteFile(file.get(), bytes.data() + offset, request_size,
                     &bytes_written, nullptr) ||
          bytes_written == 0) {
        write_succeeded = false;
        break;
      }
      offset += bytes_written;
    }
    if (write_succeeded && !FlushFileBuffers(file.get())) {
      write_succeeded = false;
    }
  }

  if (!write_succeeded) {
    DeleteFileW(temporary_path.c_str());
    return false;
  }
  if (!MoveFileExW(temporary_path.c_str(), destination.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temporary_path.c_str());
    return false;
  }
  return true;
}

void HandleSavePng(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result,
    HWND owner) {
  const auto* arguments =
      std::get_if<flutter::EncodableMap>(call.arguments());
  if (arguments == nullptr) {
    ReturnError(std::move(result), "invalid_arguments",
                "Image export request is invalid.");
    return;
  }
  const auto* bytes_value = FindArgument(*arguments, "bytes");
  const auto* name_value = FindArgument(*arguments, "suggestedName");
  const auto* bytes = bytes_value == nullptr
                          ? nullptr
                          : std::get_if<std::vector<uint8_t>>(bytes_value);
  const auto* name = name_value == nullptr
                         ? nullptr
                         : std::get_if<std::string>(name_value);
  std::wstring wide_name;
  if (bytes == nullptr || name == nullptr ||
      bytes->size() < kPngSignature.size() ||
      bytes->size() > kMaxExportBytes || !IsPng(*bytes) ||
      !Utf8ToWide(*name, &wide_name)) {
    ReturnError(std::move(result), "invalid_image",
                "The PNG image could not be exported.");
    return;
  }

  const std::wstring safe_name = SanitizePngName(std::move(wide_name));
  Microsoft::WRL::ComPtr<IFileSaveDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(dialog.GetAddressOf())))) {
    ReturnError(std::move(result), "save_dialog_failed",
                "The image save dialog could not be opened.");
    return;
  }

  static constexpr COMDLG_FILTERSPEC kPngFilter[] = {
      {L"PNG image (*.png)", L"*.png"}};
  DWORD options = 0;
  if (FAILED(dialog->GetOptions(&options)) ||
      FAILED(dialog->SetOptions(options | FOS_OVERWRITEPROMPT |
                                FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST |
                                FOS_NOCHANGEDIR | FOS_STRICTFILETYPES)) ||
      FAILED(dialog->SetFileTypes(ARRAYSIZE(kPngFilter), kPngFilter)) ||
      FAILED(dialog->SetFileTypeIndex(1)) ||
      FAILED(dialog->SetDefaultExtension(L"png")) ||
      FAILED(dialog->SetFileName(safe_name.c_str()))) {
    ReturnError(std::move(result), "save_dialog_failed",
                "The image save dialog could not be configured.");
    return;
  }

  const HRESULT show_result = dialog->Show(owner);
  if (show_result == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
    result->Success(flutter::EncodableValue(false));
    return;
  }
  if (FAILED(show_result)) {
    ReturnError(std::move(result), "save_dialog_failed",
                "The image save dialog could not be opened.");
    return;
  }

  Microsoft::WRL::ComPtr<IShellItem> selected_item;
  PWSTR selected_path = nullptr;
  if (FAILED(dialog->GetResult(selected_item.GetAddressOf())) ||
      FAILED(selected_item->GetDisplayName(SIGDN_FILESYSPATH,
                                           &selected_path)) ||
      selected_path == nullptr) {
    if (selected_path != nullptr) CoTaskMemFree(selected_path);
    ReturnError(std::move(result), "save_path_failed",
                "The selected destination could not be used.");
    return;
  }

  std::wstring destination(selected_path);
  CoTaskMemFree(selected_path);
  if (!HasPngExtension(destination)) {
    ReturnError(std::move(result), "invalid_destination",
                "Choose a PNG file name.");
    return;
  }
  if (!WriteAndPublishPng(destination, *bytes)) {
    ReturnError(std::move(result), "save_failed",
                "The PNG image could not be saved.");
    return;
  }
  result->Success(flutter::EncodableValue(true));
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
        if (call.method_name() == "pickImage") {
          HandlePickImage(call, std::move(result), owner);
          return;
        }
        if (call.method_name() == "savePng") {
          HandleSavePng(call, std::move(result), owner);
          return;
        }
        result->NotImplemented();
      });
}

FilesChannel::~FilesChannel() {
  if (channel_ != nullptr) {
    channel_->SetMethodCallHandler(nullptr);
  }
}
