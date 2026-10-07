#include <jni.h>
#include <stdint.h>
#include <string.h>

#include "_cgo_export.h"

#define PROOF_AND_PUBLIC 512
#define CLAIM_PROOF_AND_PUBLIC 352

static jint load(JNIEnv *env, jclass cls, jstring dir) {
  const char *path = (*env)->GetStringUTFChars(env, dir, NULL);
  if (path == NULL) return -2;
  jint rc = BuckspayLoad((char *)path);
  (*env)->ReleaseStringUTFChars(env, dir, path);
  return rc;
}

static jint prove(JNIEnv *env, jclass cls, jbyteArray chain, jint index, jbyteArray out) {
  if ((*env)->GetArrayLength(env, out) < PROOF_AND_PUBLIC) return -2;
  jsize n = (*env)->GetArrayLength(env, chain);
  jbyte *in = (*env)->GetByteArrayElements(env, chain, NULL);
  if (in == NULL) return -2;
  uint8_t result[PROOF_AND_PUBLIC];
  jint rc = BuckspayProve((uint8_t *)in, (size_t)n, index, result);
  (*env)->ReleaseByteArrayElements(env, chain, in, JNI_ABORT);
  if (rc == 0) (*env)->SetByteArrayRegion(env, out, 0, PROOF_AND_PUBLIC, (jbyte *)result);
  memset(result, 0, sizeof result);
  return rc;
}

static jint loadClaim(JNIEnv *env, jclass cls, jstring dir) {
  const char *path = (*env)->GetStringUTFChars(env, dir, NULL);
  if (path == NULL) return -2;
  jint rc = BuckspayLoadClaim((char *)path);
  (*env)->ReleaseStringUTFChars(env, dir, path);
  return rc;
}

static jint proveClaim(JNIEnv *env, jclass cls, jbyteArray request, jbyteArray out) {
  if ((*env)->GetArrayLength(env, out) < CLAIM_PROOF_AND_PUBLIC) return -2;
  jsize n = (*env)->GetArrayLength(env, request);
  jbyte *in = (*env)->GetByteArrayElements(env, request, NULL);
  if (in == NULL) return -2;
  uint8_t result[CLAIM_PROOF_AND_PUBLIC];
  jint rc = BuckspayProveClaim((uint8_t *)in, (size_t)n, result);
  memset(in, 0, (size_t)n);
  (*env)->ReleaseByteArrayElements(env, request, in, 0);
  if (rc == 0) (*env)->SetByteArrayRegion(env, out, 0, CLAIM_PROOF_AND_PUBLIC, (jbyte *)result);
  memset(result, 0, sizeof result);
  return rc;
}

static jint expand(JNIEnv *env, jclass cls, jstring bin, jstring dump) {
  const char *from = (*env)->GetStringUTFChars(env, bin, NULL);
  const char *to = (*env)->GetStringUTFChars(env, dump, NULL);
  jint rc = -2;
  if (from != NULL && to != NULL) rc = BuckspayExpand((char *)from, (char *)to);
  if (from != NULL) (*env)->ReleaseStringUTFChars(env, bin, from);
  if (to != NULL) (*env)->ReleaseStringUTFChars(env, dump, to);
  return rc;
}

static void release(JNIEnv *env, jclass cls) { BuckspayRelease(); }

static const JNINativeMethod methods[] = {
    {"load", "(Ljava/lang/String;)I", (void *)load},
    {"proveInto", "([BI[B)I", (void *)prove},
    {"loadClaim", "(Ljava/lang/String;)I", (void *)loadClaim},
    {"proveClaimInto", "([B[B)I", (void *)proveClaim},
    {"expand", "(Ljava/lang/String;Ljava/lang/String;)I", (void *)expand},
    {"release", "()V", (void *)release},
};

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {
  JNIEnv *env;
  if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
  jclass cls = (*env)->FindClass(env, "xyz/buckspay/prover/Native");
  if (cls == NULL) return JNI_ERR;
  if ((*env)->RegisterNatives(env, cls, methods, sizeof methods / sizeof methods[0]) != JNI_OK) return JNI_ERR;
  return JNI_VERSION_1_6;
}
