#ifndef RUNNER_FILES_CHANNEL_H_
#define RUNNER_FILES_CHANNEL_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>

#include <windows.h>

#include <memory>

// Owns the worldpainter/files method channel for explicit user file picking.
class FilesChannel {
 public:
  explicit FilesChannel(flutter::BinaryMessenger* messenger,
                        HWND owner = nullptr);
  ~FilesChannel();

  FilesChannel(const FilesChannel&) = delete;
  FilesChannel& operator=(const FilesChannel&) = delete;

 private:
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
};

#endif  // RUNNER_FILES_CHANNEL_H_
