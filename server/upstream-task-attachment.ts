import axios from "axios";

import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";

export async function uploadUpstreamTaskAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
}) {
  const mimeType = input.mimeType || "application/zip";
  const authHeaders = {
    API_KEY: input.apiKey,
    Authorization: `Bearer ${input.apiKey}`,
  };
  const created = await axios.post(
    `${input.baseUrl}/v1/files`,
    { filename: input.filename },
    {
      headers: { ...authHeaders, "Content-Type": "application/json" },
      timeout: 120_000,
      validateStatus: () => true,
    },
  );
  const fileId = String(created.data?.id || created.data?.file_id || "");
  if (created.status < 200 || created.status >= 300 || !fileId) {
    throw new Error(`Task attachment creation failed: ${input.filename}`);
  }

  const removeOrphan = async () => {
    await axios
      .delete(
        `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers: authHeaders,
          timeout: 30_000,
          validateStatus: () => true,
        },
      )
      .catch(() => undefined);
  };

  try {
    let uploadUrl = String(created.data?.upload_url || "");
    if (!uploadUrl) {
      const metadata = await axios.get(
        `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers: authHeaders,
          timeout: 30_000,
          validateStatus: () => true,
        },
      );
      if (metadata.status < 200 || metadata.status >= 300) {
        throw new Error(
          `Task attachment upload URL lookup failed: ${input.filename}`,
        );
      }
      uploadUrl = String(metadata.data?.upload_url || "");
    }
    const target = assertSafeExternalUrl(uploadUrl);
    const uploaded = await axios.put(target, input.bytes, {
      ...safeExternalRequestOptions,
      // Query-signed uploads must use the exact URL and cannot carry API auth.
      maxRedirects: 0,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(input.bytes.length),
      },
      timeout: 120_000,
      maxBodyLength: input.bytes.length,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true,
    });
    if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new Error(`Task attachment upload failed: ${input.filename}`);
    }
    return {
      attachment: { file_id: fileId, filename: input.filename },
      fileId,
      removeOrphan,
    };
  } catch (error) {
    await removeOrphan();
    throw error;
  }
}
