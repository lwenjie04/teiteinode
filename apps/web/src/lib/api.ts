import type { AiStatus, Diary, SegmentRequest, SegmentResponse, StylizeRequest, StylizeResponse, UserSettings } from "@tietie/shared";

const API_PREFIX = "/api";

export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  relativeUrl: string;
  url: string;
  metadataStored?: boolean;
  storage?: string;
}

async function buildResponseError(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  let detail = text.trim();
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { message?: string; error?: string };
      detail = parsed.message || parsed.error || detail;
    } catch {
      // Keep the raw response text when it is not JSON.
    }
  }
  return new Error(`${fallback}: ${response.status}${detail ? ` ${detail}` : ""}`);
}

async function fetchJson<T>(url: string, options: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    if (!response.ok) throw await buildResponseError(response, "请求失败");
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`请求超时：${Math.round(timeoutMs / 1000)} 秒内没有完成`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function getAiStatus(): Promise<AiStatus> {
  return fetchJson<AiStatus>(`${API_PREFIX}/ai/status`, {}, 5000);
}

export async function sendEmailCode(email: string) {
  return fetchJson<{ ok: boolean; message: string; devCode?: string; expiresInSeconds: number }>(`${API_PREFIX}/auth/email-code/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
}

export async function verifyEmailCode(email: string, code: string) {
  return fetchJson<{ token: string; user: { id: string; email: string } }>(`${API_PREFIX}/auth/email-code/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code })
  });
}

export async function uploadImage(token: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_PREFIX}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  });
  if (!response.ok) throw await buildResponseError(response, "图片上传失败");
  return response.json() as Promise<UploadedFile>;
}

export async function getFileStats(token: string) {
  return fetchJson<{ storage: string; count: number; totalSize: number }>(
    `${API_PREFIX}/files/stats`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    5000
  );
}

export async function listUploadedFiles(token: string) {
  return fetchJson<{ storage: string; items: Array<UploadedFile & { createdAt: string; storagePath?: string }>; message?: string }>(
    `${API_PREFIX}/files`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    5000
  );
}

export async function deleteUploadedFile(token: string, id: string) {
  return fetchJson<{ ok: boolean; deletedMetadata: boolean; deletedFile: boolean; message: string }>(
    `${API_PREFIX}/files/${id}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    5000
  );
}

export async function pushDiaries(token: string, diaries: Diary[], deletedDiaryIds: string[] = [], settings?: UserSettings) {
  return fetchJson<{ accepted: number; conflicts: Array<{ id: string; kept: "client" | "server" }>; serverTime: string; storage: string; diaries: Diary[]; settings: UserSettings | null }>(
    `${API_PREFIX}/sync/push`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ diaries, deletedDiaryIds, settings })
    },
    12000
  );
}

export async function pullDiaries(token: string) {
  return fetchJson<{ serverTime: string; storage: string; diaries: Diary[]; settings: UserSettings | null }>(
    `${API_PREFIX}/sync/pull`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    12000
  );
}

export async function generateDiary(token: string, payload: Record<string, unknown>) {
  return fetchJson<{ text: string; model: string; policy: string }>(`${API_PREFIX}/ai/generate-diary`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export async function segmentSubject(token: string, payload: SegmentRequest) {
  return fetchJson<SegmentResponse>(
    `${API_PREFIX}/ai/segment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    },
    30000
  );
}

export async function stylizeSticker(token: string, payload: StylizeRequest) {
  return fetchJson<StylizeResponse>(
    `${API_PREFIX}/ai/stylize`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    },
    30000
  );
}
