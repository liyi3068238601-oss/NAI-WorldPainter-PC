#include "credential_channel.h"

#include <windows.h>
#include <wincred.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <flutter/standard_method_codec.h>

namespace {

constexpr char kChannelName[] = "worldpainter/credentials";
constexpr size_t kMaxScopeSegmentLength = 64;
constexpr DWORD kMaxCredentialBytes = CRED_MAX_CREDENTIAL_BLOB_SIZE;
constexpr wchar_t kTargetPrefix[] = L"WorldPainter/credential/v1/";

bool IsAsciiAlphaNumeric(unsigned char value) {
  return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
         (value >= '0' && value <= '9');
}

bool IsScopeSegment(const std::string& value) {
  if (value.empty() || value.size() > kMaxScopeSegmentLength ||
      !IsAsciiAlphaNumeric(static_cast<unsigned char>(value.front()))) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return IsAsciiAlphaNumeric(character) || character == '.' ||
           character == '_' || character == '-';
  });
}

const flutter::EncodableValue* FindArgument(
    const flutter::EncodableMap& arguments, const char* name) {
  const auto found = arguments.find(flutter::EncodableValue(name));
  return found == arguments.end() ? nullptr : &found->second;
}

bool ReadStringArgument(const flutter::EncodableMap& arguments,
                        const char* name, std::string* output) {
  const auto* value = FindArgument(arguments, name);
  if (value == nullptr || !std::holds_alternative<std::string>(*value)) {
    return false;
  }
  *output = std::get<std::string>(*value);
  return true;
}

bool ReadScope(const flutter::MethodCall<flutter::EncodableValue>& call,
               bool has_secret, std::string* provider, std::string* key,
               std::string* secret) {
  const auto* value = call.arguments();
  if (value == nullptr ||
      !std::holds_alternative<flutter::EncodableMap>(*value)) {
    return false;
  }
  const auto& arguments = std::get<flutter::EncodableMap>(*value);
  const size_t expected_count = has_secret ? 3 : 2;
  if (arguments.size() != expected_count ||
      !ReadStringArgument(arguments, "provider", provider) ||
      !ReadStringArgument(arguments, "key", key) ||
      (has_secret && !ReadStringArgument(arguments, "secret", secret))) {
    return false;
  }
  return true;
}

bool IsValidSecret(const std::string& secret) {
  return !secret.empty() && secret.find('\0') == std::string::npos &&
         secret.size() <= kMaxCredentialBytes;
}

std::wstring BuildTargetName(const std::string& provider,
                             const std::string& key) {
  std::wstring target(kTargetPrefix);
  target.append(provider.begin(), provider.end());
  target.push_back(L'/');
  target.append(key.begin(), key.end());
  return target;
}

void ReturnError(
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result,
    const char* code, const char* message) {
  result->Error(code, message);
}

class CredentialBuffer {
 public:
  explicit CredentialBuffer(PCREDENTIALW value) : value_(value) {}
  ~CredentialBuffer() {
    if (value_ != nullptr) {
      if (value_->CredentialBlob != nullptr &&
          value_->CredentialBlobSize > 0 &&
          value_->CredentialBlobSize <= kMaxCredentialBytes) {
        SecureZeroMemory(value_->CredentialBlob,
                         value_->CredentialBlobSize);
      }
      CredFree(value_);
    }
  }

  CredentialBuffer(const CredentialBuffer&) = delete;
  CredentialBuffer& operator=(const CredentialBuffer&) = delete;

  PCREDENTIALW get() const { return value_; }

 private:
  PCREDENTIALW value_;
};

void HandleCredentialCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();
  const bool is_save = method == "save";
  const bool is_read = method == "read";
  const bool is_delete = method == "delete";
  if (!is_save && !is_read && !is_delete) {
    result->NotImplemented();
    return;
  }

  std::string provider;
  std::string key;
  std::string secret;
  if (!ReadScope(call, is_save, &provider, &key, &secret)) {
    ReturnError(std::move(result), "invalid_arguments",
                "Credential request is invalid.");
    return;
  }
  if (!IsScopeSegment(provider) || !IsScopeSegment(key) ||
      (is_save && !IsValidSecret(secret))) {
    ReturnError(std::move(result), "invalid_scope",
                "Credential scope or value is invalid.");
    return;
  }

  const std::wstring target = BuildTargetName(provider, key);
  if (is_save) {
    std::vector<BYTE> secret_bytes(secret.begin(), secret.end());
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<LPWSTR>(target.c_str());
    credential.CredentialBlobSize =
        static_cast<DWORD>(secret_bytes.size());
    credential.CredentialBlob = secret_bytes.data();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;

    const BOOL saved = CredWriteW(&credential, 0);
    SecureZeroMemory(secret_bytes.data(), secret_bytes.size());
    SecureZeroMemory(secret.data(), secret.size());
    if (!saved) {
      ReturnError(std::move(result), "credential_unavailable",
                  "Credential could not be saved.");
      return;
    }
    result->Success(flutter::EncodableValue());
    return;
  }

  if (is_read) {
    PCREDENTIALW raw_credential = nullptr;
    if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &raw_credential)) {
      if (GetLastError() == ERROR_NOT_FOUND) {
        result->Success(flutter::EncodableValue());
      } else {
        ReturnError(std::move(result), "credential_unavailable",
                    "Credential could not be read.");
      }
      return;
    }
    CredentialBuffer credential(raw_credential);
    const auto* stored = credential.get();
    if (stored->CredentialBlob == nullptr ||
        stored->CredentialBlobSize == 0 ||
        stored->CredentialBlobSize > kMaxCredentialBytes) {
      ReturnError(std::move(result), "credential_unavailable",
                  "Credential could not be read.");
      return;
    }

    std::string stored_secret(
        reinterpret_cast<const char*>(stored->CredentialBlob),
        stored->CredentialBlobSize);
    flutter::EncodableValue returned(stored_secret);
    result->Success(returned);
    SecureZeroMemory(stored_secret.data(), stored_secret.size());
    auto& returned_secret = std::get<std::string>(returned);
    SecureZeroMemory(returned_secret.data(), returned_secret.size());
    return;
  }

  if (!CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0) &&
      GetLastError() != ERROR_NOT_FOUND) {
    ReturnError(std::move(result), "credential_unavailable",
                "Credential could not be deleted.");
    return;
  }
  result->Success(flutter::EncodableValue());
}

}  // namespace

CredentialChannel::CredentialChannel(flutter::BinaryMessenger* messenger)
    : channel_(std::make_unique<
          flutter::MethodChannel<flutter::EncodableValue>>(
          messenger, kChannelName,
          &flutter::StandardMethodCodec::GetInstance())) {
  channel_->SetMethodCallHandler(
      [](const flutter::MethodCall<flutter::EncodableValue>& call,
         std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
             result) { HandleCredentialCall(call, std::move(result)); });
}

CredentialChannel::~CredentialChannel() {
  if (channel_ != nullptr) {
    channel_->SetMethodCallHandler(nullptr);
  }
}
