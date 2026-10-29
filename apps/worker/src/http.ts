import type { KdError, KdErrorCode } from "key-doctor";

const TEXT: Partial<Record<KdErrorCode, { vi: string; en: string }>> = {
  UNAUTHORIZED: { vi: "Không có quyền thực hiện yêu cầu này.", en: "You are not allowed to do this." },
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export function kdErrorBody(code: KdErrorCode, message?: { vi: string; en: string }, retryable = false): KdError {
  return {
    schema_version: "kd.error.v1",
    code,
    message: message ?? TEXT[code] ?? { vi: "Yêu cầu không hợp lệ.", en: "Invalid request." },
    retryable,
  };
}

export const unauthorized = () => json(kdErrorBody("UNAUTHORIZED"), 401, { "www-authenticate": "Bearer" });

/** Reads a JSON body of at most `limit` bytes; null when it is too large or not JSON. */
export async function readJson(request: Request, limit = 64 * 1024): Promise<unknown | null> {
  const text = await request.text();
  if (text.length > limit) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
