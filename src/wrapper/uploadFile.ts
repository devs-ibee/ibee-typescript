// Hand-written (listed in src/.fernignore): send one file with an upload link.
//
// The three steps the contract describes for createObjectUploadLink: compute the
// file's size and SHA-256 (base64), ask for the link with them, and PUT the file to
// the link with exactly the headers in the answer. The file goes to the workspace's
// S3 host, never through the API, and the API token is not sent with it. Nothing is
// checked before sending: the server decides the limits and refuses what it does not
// accept; a refused PUT throws IbeeError with the S3 gateway's answer.

import type * as Ibee from "../api/index.js";
import { IbeeError } from "../errors/index.js";

/** The whole file: bytes, a Blob (or File), or text (sent as UTF-8). */
export type UploadFileData = Uint8Array | ArrayBuffer | Blob | string;

export interface UploadFileRequest {
    bucket_name: string;
    /** The object's key, such as `docs/report.pdf`; `/` separates segments. */
    object_path: string;
    data: UploadFileData;
    /** The file's media type; signed into the link and sent with the upload. */
    content_type?: string;
    /** Seconds the link works (the server's range applies). */
    expires?: number;
    workspace_id?: string;
}

export interface UploadedObject {
    bucket_name: string;
    object_path: string;
    size_bytes: number;
    checksum_sha256: string;
    /** The S3 gateway's ETag for the stored object, when it sent one. */
    etag?: string;
}

type LinkMaker = (request: Ibee.ObjectUploadLinkRequest) => PromiseLike<Ibee.ObjectUploadLink>;

export async function toBytes(data: UploadFileData): Promise<Uint8Array> {
    if (typeof data === "string") return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(await data.arrayBuffer());
}

/** The SHA-256 of `bytes`, base64-encoded (44 characters), as upload links take it. */
export async function checksumSha256(bytes: Uint8Array): Promise<string> {
    const subtle =
        (globalThis as { crypto?: Crypto }).crypto?.subtle ??
        ((await import("node:crypto")).webcrypto.subtle as unknown as SubtleCrypto);
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as BufferSource));
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export async function uploadFile(
    makeLink: LinkMaker,
    fetchFn: typeof fetch,
    request: UploadFileRequest,
): Promise<UploadedObject> {
    const { data, ...rest } = request;
    const bytes = await toBytes(data);
    const checksum = await checksumSha256(bytes);
    const link = await makeLink({ ...rest, size_bytes: bytes.byteLength, checksum_sha256: checksum });
    // fetch sets Content-Length from the body (the same value the link signed); no Authorization is sent.
    const headers = Object.fromEntries(
        Object.entries(link.headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-length"),
    );
    const response = await fetchFn(link.url, {
        method: link.method ?? "PUT",
        headers,
        body: bytes as unknown as BodyInit,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new IbeeError({
            message: `Upload to the link failed (${response.status}).`,
            statusCode: response.status,
            body: text,
        });
    }
    return {
        bucket_name: request.bucket_name,
        object_path: request.object_path,
        size_bytes: bytes.byteLength,
        checksum_sha256: checksum,
        etag: response.headers.get("etag") ?? undefined,
    };
}
