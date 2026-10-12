#ifndef RUNNER_CREDENTIAL_CHANNEL_H_
#define RUNNER_CREDENTIAL_CHANNEL_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>

#include <memory>

// Owns the worldpainter/credentials method channel. Keep this independent of
// FlutterWindow so the runner can install it without mixing window behavior
// into credential storage.
class CredentialChannel {
 public:
  explicit CredentialChannel(flutter::BinaryMessenger* messenger);
  ~CredentialChannel();

  CredentialChannel(const CredentialChannel&) = delete;
  CredentialChannel& operator=(const CredentialChannel&) = delete;

 private:
  std::unique_ptr<
      flutter::MethodChannel<flutter::EncodableValue>> channel_;
};

#endif  // RUNNER_CREDENTIAL_CHANNEL_H_
