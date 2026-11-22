#ifndef CLOUD_CLIENT_H
#define CLOUD_CLIENT_H

#include <Arduino.h>
#include "usb_printer.h"

class CloudClient {
public:
  CloudClient(UsbPrinter& printer);
  void begin(const char* serverUrl, const char* token);
  void task();

private:
  UsbPrinter& _printer;
  String _serverUrl;
  String _token;
  unsigned long _lastPollMs;
  bool _configured;

  void _pollAndPrint();
  bool _streamJob(const String& jobId, size_t expectedSize);
  void _reportDone(const String& jobId, bool ok);
};

#endif
