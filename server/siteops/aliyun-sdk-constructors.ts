import * as AliDnsSdk from "@alicloud/alidns20150109";
import * as CredentialsSdk from "@alicloud/credentials";
import * as DomainSdk from "@alicloud/domain20180129";
import * as EsaSdk from "@alicloud/esa20240910";
import * as StsSdk from "@alicloud/sts20150401";

type SdkConstructor = new (...args: any[]) => any;

export type AliyunDnsClientConstructor =
  (typeof import("@alicloud/alidns20150109"))["default"];
export type AliyunCredentialConstructor =
  (typeof import("@alicloud/credentials"))["default"];
export type AliyunDomainClientConstructor =
  (typeof import("@alicloud/domain20180129"))["default"];
export type AliyunEsaClientConstructor =
  (typeof import("@alicloud/esa20240910"))["default"];
export type AliyunStsClientConstructor =
  (typeof import("@alicloud/sts20150401"))["default"];

function defaultExport(value: unknown) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  return (value as { default?: unknown }).default;
}

export function resolveAliyunSdkConstructor<
  TConstructor extends SdkConstructor,
>(sdkModule: unknown): TConstructor {
  const firstDefault = defaultExport(sdkModule);
  const candidates = [sdkModule, firstDefault, defaultExport(firstDefault)];
  const constructor = candidates.find(
    (candidate) => typeof candidate === "function",
  );
  if (!constructor) {
    throw new TypeError("Alibaba Cloud SDK constructor is unavailable");
  }
  return constructor as TConstructor;
}

export const AliyunDnsClient =
  resolveAliyunSdkConstructor<AliyunDnsClientConstructor>(AliDnsSdk);
export const AliyunCredential =
  resolveAliyunSdkConstructor<AliyunCredentialConstructor>(CredentialsSdk);
export const AliyunDomainClient =
  resolveAliyunSdkConstructor<AliyunDomainClientConstructor>(DomainSdk);
export const AliyunEsaClient =
  resolveAliyunSdkConstructor<AliyunEsaClientConstructor>(EsaSdk);
export const AliyunStsClient =
  resolveAliyunSdkConstructor<AliyunStsClientConstructor>(StsSdk);
