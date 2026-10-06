#include <jni.h>

#include <vector>

#include "ggwave/ggwave.h"

namespace {

constexpr float kSampleRate = 48000.0f;
constexpr int kFrameSamples = 1024;
constexpr int kMaxPayload = 256;

void throwIllegalArgument(JNIEnv* env, const char* message) {
  jclass type = env->FindClass("java/lang/IllegalArgumentException");
  if (type != nullptr) env->ThrowNew(type, message);
}

// The protocol toggles are global to the library: switching every protocol off but the one in use is
// what keeps the decoder from reporting another protocol's frames.
void enableOnly(int protocol, bool rx) {
  for (int id = 0; id < GGWAVE_PROTOCOL_COUNT; ++id) {
    const bool enabled = id == protocol;
    if (rx) {
      ggwave_rxToggleProtocol(static_cast<ggwave_ProtocolId>(id), enabled);
    } else {
      ggwave_txToggleProtocol(static_cast<ggwave_ProtocolId>(id), enabled);
    }
  }
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) {
  ggwave_setLogFile(nullptr);
  return JNI_VERSION_1_6;
}

JNIEXPORT jint JNICALL Java_xyz_buckspay_copresence_Ggwave_nativeCreate(JNIEnv*, jobject, jint protocol, jboolean rx) {
  enableOnly(protocol, rx == JNI_TRUE);
  ggwave_Parameters parameters = ggwave_getDefaultParameters();
  parameters.payloadLength = -1;
  parameters.sampleRateInp = kSampleRate;
  parameters.sampleRateOut = kSampleRate;
  parameters.sampleRate = kSampleRate;
  parameters.samplesPerFrame = kFrameSamples;
  parameters.sampleFormatInp = GGWAVE_SAMPLE_FORMAT_I16;
  parameters.sampleFormatOut = GGWAVE_SAMPLE_FORMAT_I16;
  parameters.operatingMode = rx == JNI_TRUE ? GGWAVE_OPERATING_MODE_RX : GGWAVE_OPERATING_MODE_TX;
  return ggwave_init(parameters);
}

JNIEXPORT jshortArray JNICALL Java_xyz_buckspay_copresence_Ggwave_nativeEncode(
    JNIEnv* env, jobject, jint instance, jbyteArray payload, jint protocol, jint volume) {
  const jsize length = env->GetArrayLength(payload);
  std::vector<jbyte> bytes(static_cast<size_t>(length));
  env->GetByteArrayRegion(payload, 0, length, bytes.data());
  const int samples = ggwave_encode(instance, bytes.data(), length, static_cast<ggwave_ProtocolId>(protocol), volume, nullptr, 2);
  if (samples <= 0) {
    throwIllegalArgument(env, "The payload cannot be encoded");
    return nullptr;
  }
  std::vector<jshort> waveform(static_cast<size_t>(samples));
  if (ggwave_encode(instance, bytes.data(), length, static_cast<ggwave_ProtocolId>(protocol), volume, waveform.data(), 0) <= 0) {
    throwIllegalArgument(env, "The payload cannot be encoded");
    return nullptr;
  }
  jshortArray out = env->NewShortArray(samples);
  if (out != nullptr) env->SetShortArrayRegion(out, 0, samples, waveform.data());
  return out;
}

JNIEXPORT jbyteArray JNICALL Java_xyz_buckspay_copresence_Ggwave_nativeDecode(
    JNIEnv* env, jobject, jint instance, jshortArray frame) {
  if (env->GetArrayLength(frame) != kFrameSamples) {
    throwIllegalArgument(env, "A frame must be exactly 1024 samples");
    return nullptr;
  }
  jshort samples[kFrameSamples];
  env->GetShortArrayRegion(frame, 0, kFrameSamples, samples);
  jbyte payload[kMaxPayload];
  const int length = ggwave_decode(instance, samples, kFrameSamples * sizeof(jshort), payload);
  if (length <= 0) return nullptr;
  jbyteArray out = env->NewByteArray(length);
  if (out != nullptr) env->SetByteArrayRegion(out, 0, length, payload);
  return out;
}

JNIEXPORT void JNICALL Java_xyz_buckspay_copresence_Ggwave_nativeFree(JNIEnv*, jobject, jint instance) {
  ggwave_free(instance);
}

}  // extern "C"
