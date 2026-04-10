/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, Button, Constants, FluxDispatcher, Forms, MessageStore, RestAPI, showToast, Toasts } from "@webpack/common";

const logger = new Logger("S3Upload");
const enc = new TextEncoder();

type LinkMode = "direct" | "signedGet";

type S3Credentials = {
    accessKeyId: string;
    secretAccessKey: string;
};

type S3EndpointConfig = {
    endpoint: string;
    bucket: string;
    region: string;
    forcePathStyle: boolean;
};

type MultipartPart = {
    partNumber: number;
    etag: string;
};

type S3UploadHistoryItem = {
    uploadedAt: string;
    fileName: string;
    fileSize: number;
    objectKey: string;
    url: string;
};

type UploadFile = {
    name: string;
    size: number;
    type: string;
    destination: string;
    nativeFile: File;
    sourceUpload: any;
};

const cspPromptedOrigins = new Set<string>();
const URL_REGEX = /https?:\/\/[^\s<>()]+/g;

const settings = definePluginSettings({
    autoUpload: {
        type: OptionType.BOOLEAN,
        description: "Automatically upload files without asking for confirmation",
        default: true,
    },
    uploadEverything: {
        type: OptionType.BOOLEAN,
        description: "Use S3 for all files, including files within Discord upload limit",
        default: false,
    },
    linkMode: {
        type: OptionType.SELECT,
        description: "Link type to share after upload",
        options: [
            { label: "Direct URL", value: "direct" },
            { label: "Signed GET URL", value: "signedGet", default: true },
        ],
    },
    signedGetExpiresSec: {
        type: OptionType.NUMBER,
        description: "Signed GET link expiry in seconds",
        default: 31556926,
        // disabled: () => settings.store.linkMode !== "signedGet",
    },
    presignedPutExpiresSec: {
        type: OptionType.NUMBER,
        description: "Presigned PUT link expiry in seconds",
        default: 900,
    },
    useMultipartForLargeFiles: {
        type: OptionType.BOOLEAN,
        description: "Use S3 Multipart Upload for large files (recommended behind Cloudflare)",
        default: true,
    },
    multipartThresholdMiB: {
        type: OptionType.NUMBER,
        description: "Use multipart when file size is at least this MiB",
        default: 95,
        // disabled: () => !settings.store.useMultipartForLargeFiles,
    },
    multipartPartSizeMiB: {
        type: OptionType.NUMBER,
        description: "Multipart part size in MiB (keep under 100MB for Cloudflare)",
        default: 95,
        // disabled: () => !settings.store.useMultipartForLargeFiles,
    },
    uploadStallTimeoutSec: {
        type: OptionType.NUMBER,
        description: "Abort upload if no progress is observed for this many seconds",
        default: 45,
    },
    verbose: {
        type: OptionType.BOOLEAN,
        description: "Enable verbose logs",
        default: false,
    },
    autoRequestNativeCspOverride: {
        type: OptionType.BOOLEAN,
        description: "Desktop only: Automatically request connect-src CSP allow for the S3 endpoint",
        default: true,
    },
    appendMetadataFragment: {
        type: OptionType.BOOLEAN,
        description: "Append filename/size metadata in URL fragment for better attachment rendering",
        default: true,
    },
    hideRenderedS3Links: {
        type: OptionType.BOOLEAN,
        description: "Hide S3 link text in rendered message content",
        default: true,
    },
    endpoint: {
        type: OptionType.STRING,
        description: "S3 endpoint URL (e.g. https://s3.amazonaws.com or https://<account>.r2.cloudflarestorage.com)",
        placeholder: "https://example.com",
        default: "",
    },
    bucket: {
        type: OptionType.STRING,
        description: "S3 bucket name",
        default: "",
    },
    region: {
        type: OptionType.STRING,
        description: "S3 region used for signature scope",
        default: "auto",
    },
    accessKeyId: {
        type: OptionType.STRING,
        description: "S3 access key id",
        default: "",
    },
    secretAccessKey: {
        type: OptionType.STRING,
        description: "S3 secret access key",
        default: "",
    },
    objectPrefix: {
        type: OptionType.STRING,
        description: "Prefix for uploaded object keys",
        default: "uploads",
    },
    forcePathStyle: {
        type: OptionType.BOOLEAN,
        description: "Use path-style URLs: endpoint/bucket/key",
        default: true,
    },
    publicUrlTemplate: {
        type: OptionType.STRING,
        description: "Optional template for direct URL. Variables: {endpoint} {bucket} {key}",
        default: "",
    },
    storageWarning: {
        type: OptionType.COMPONENT,
        component: () => (
            <Forms.FormText style={{ color: "var(--text-danger)" }}>
                Security warning: Access key and secret are stored in plaintext as requested.
            </Forms.FormText>
        )
    },
    historySummary: {
        type: OptionType.COMPONENT,
        component: () => {
            const history = getUploadHistory();
            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <Forms.FormText>
                        Upload History: {history.length}
                    </Forms.FormText>
                    <Button onClick={() => {
                        settings.store.historyJson = "[]";
                        showToast("S3 upload history cleared", Toasts.Type.SUCCESS);
                    }}>
                        Clear Upload History
                    </Button>
                </div>
            );
        }
    },
    historyJson: {
        type: OptionType.STRING,
        hidden: true,
        default: "[]",
    },
});

function vlog(...args: unknown[]) {
    if (settings.store.verbose) logger.info(...args);
}

function getEffectiveLinkMode(): LinkMode {
    return settings.store.linkMode === "signedGet" ? "signedGet" : "direct";
}

function getRegion() {
    return (settings.store.region || "auto").trim() || "auto";
}

function getCredentials(): S3Credentials {
    return {
        accessKeyId: settings.store.accessKeyId.trim(),
        secretAccessKey: settings.store.secretAccessKey.trim(),
    };
}

function getEndpointConfig(): S3EndpointConfig {
    return {
        endpoint: settings.store.endpoint.trim(),
        bucket: settings.store.bucket.trim(),
        region: getRegion(),
        forcePathStyle: settings.store.forcePathStyle,
    };
}

function isConfigured() {
    const { accessKeyId, secretAccessKey } = getCredentials();
    const { bucket, endpoint } = getEndpointConfig();
    return Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
}

function assertConfigured() {
    if (!isConfigured()) throw new Error("endpoint, bucket, access key id, and secret access key are required");
}

function normalizeEndpoint(endpoint: string) {
    const trimmed = endpoint.trim();
    if (!trimmed) throw new Error("S3 endpoint is required");
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

function tryGetOrigin(url: string) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function getTemplateOrigin(template: string) {
    if (!template) return null;
    const normalized = template
        .replaceAll("{endpoint}", "https://example.com")
        .replaceAll("{bucket}", "bucket")
        .replaceAll("{key}", "key");
    return tryGetOrigin(normalized);
}

function extractUrls(text: string) {
    return text.match(URL_REGEX) ?? [];
}

function normalizeUrlToken(token: string) {
    let t = token.trim();
    // Remove common wrappers around links in markdown/text
    t = t.replace(/^[[`"'(<]+/, "");
    t = t.replace(/[`"')>\],.;:!?]+$/, "");
    return t;
}

function decodeFilenameFromUrl(url: string) {
    try {
        const u = new URL(url);
        const last = u.pathname.split("/").filter(Boolean).at(-1);
        if (!last) return "file";
        return decodeURIComponent(last);
    } catch {
        return "file";
    }
}

function stripHash(url: string) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}${u.search}`;
    } catch {
        return url.split("#")[0];
    }
}

function parseS3Metadata(url: string) {
    try {
        const hash = new URL(url).hash.replace(/^#/, "");
        if (!hash) return null;
        const p = new URLSearchParams(hash);
        if (p.get("s3u") !== "1") return null;
        const fn = p.get("fn") ? decodeURIComponent(p.get("fn")!) : null;
        const szRaw = p.get("sz");
        const sz = szRaw != null ? Number(szRaw) : null;
        const k = p.get("k") ? decodeURIComponent(p.get("k")!) : null;
        return {
            fileName: fn,
            fileSize: Number.isFinite(sz) && sz! >= 0 ? sz : null,
            objectKey: k,
        };
    } catch {
        return null;
    }
}

function withS3MetadataFragment(url: string, file: File, objectKey: string) {
    if (!settings.store.appendMetadataFragment) return url;
    const meta = new URLSearchParams();
    meta.set("s3u", "1");
    meta.set("fn", encodeURIComponent(file.name));
    meta.set("sz", String(file.size));
    meta.set("k", encodeURIComponent(objectKey));
    const glue = url.includes("#") ? "&" : "#";
    return `${url}${glue}${meta.toString()}`;
}

function guessContentType(fileName: string) {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".zip")) return "application/zip";
    if (lower.endsWith(".7z")) return "application/x-7z-compressed";
    if (lower.endsWith(".rar")) return "application/vnd.rar";
    if (lower.endsWith(".iso")) return "application/x-iso9660-image";
    return "application/octet-stream";
}

function makeVirtualAttachment(url: string, idx: number) {
    const meta = parseS3Metadata(url);
    const cleanUrl = stripHash(url);
    const filename = meta?.fileName || decodeFilenameFromUrl(cleanUrl);
    const contentType = guessContentType(filename);
    return {
        id: `s3upload-link-${Date.now()}-${idx}`,
        filename,
        url: cleanUrl,
        proxy_url: cleanUrl,
        size: meta?.fileSize ?? 0,
        content_type: contentType,
        width: null,
        height: null,
        ephemeral: false,
        spoiler: false,
    };
}

function shouldTreatAsS3Link(url: string) {
    const endpointOrigin = tryGetOrigin(settings.store.endpoint.trim());
    const templateOrigin = getTemplateOrigin(settings.store.publicUrlTemplate.trim());
    const normalized = normalizeUrlToken(url);
    const urlOrigin = tryGetOrigin(stripHash(normalized));
    if (!urlOrigin) return false;
    if (endpointOrigin && urlOrigin === endpointOrigin) return true;
    if (templateOrigin && urlOrigin === templateOrigin) return true;
    return false;
}

function stripS3LinksFromContent(content: any) {
    if (!settings.store.hideRenderedS3Links) return content;
    if (typeof content !== "string") return content;

    let next = content;
    // Inline-code wrapped links: ``https://...`` or `https://...`
    next = next.replace(/`+(https?:\/\/[^\n`]+)`+/g, (full, inner) =>
        shouldTreatAsS3Link(inner) ? " " : full
    );
    // Bare links
    next = next.replace(/https?:\/\/[^\s<>()]+/g, full =>
        shouldTreatAsS3Link(full) ? " " : full
    );

    return next
        .split("\n")
        .map(s => s.replace(/`{2,}/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}

function shouldHideRenderedLink(url: any) {
    if (!settings.store.hideRenderedS3Links) return false;
    if (typeof url !== "string" || !url) return false;
    return shouldTreatAsS3Link(url);
}

function injectS3LinksForRender(attachments: any, messageLike: any) {
    const existing = Array.isArray(attachments) ? attachments : [];
    const content = typeof messageLike?.content === "string"
        ? messageLike.content
        : typeof messageLike?.message?.content === "string"
            ? messageLike.message.content
            : "";
    if (!content) return existing;

    const messageId = messageLike?.id ?? messageLike?.message?.id;
    const urls = extractUrls(content)
        .map(normalizeUrlToken)
        .filter(Boolean)
        .filter(shouldTreatAsS3Link);
    if (!urls.length) return existing;

    const existingUrls = new Set(existing.map((a: any) => a?.url).filter(Boolean));
    const toAdd = urls
        .filter(u => !existingUrls.has(u))
        .map((u, i) => makeVirtualAttachment(u, i));
    if (!toAdd.length) return existing;

    vlog("Injected S3 links as attachments (render)", {
        messageId,
        count: toAdd.length,
    });
    return [...existing, ...toAdd];
}

function trimSlashes(value: string) {
    return value.replace(/^\/+|\/+$/g, "");
}

function encodeRfc3986(value: string) {
    return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key: string) {
    return key.split("/").filter(Boolean).map(encodeRfc3986).join("/");
}

function getObjectKey(fileName: string) {
    const prefix = trimSlashes(settings.store.objectPrefix || "");
    const random = Math.random().toString(36).slice(2, 10);
    const timestamp = Date.now();
    const safeName = fileName.replace(/\s+/g, "-").replace(/[^\w.-]/g, "_");
    const suffix = `${timestamp}-${random}-${safeName}`;
    return prefix ? `${prefix}/${suffix}` : suffix;
}

function buildS3Target(bucket: string, key: string) {
    const endpoint = normalizeEndpoint(settings.store.endpoint);
    const encodedKey = encodeKeyPath(key);

    if (settings.store.forcePathStyle) {
        const path = `${trimSlashes(endpoint.pathname)}/${encodeRfc3986(bucket)}/${encodedKey}`.replace(/^\/+/, "");
        return {
            url: `${endpoint.origin}/${path}`,
            host: endpoint.host,
            canonicalUri: `/${path}`,
        };
    }

    const host = `${bucket}.${endpoint.host}`;
    const basePath = trimSlashes(endpoint.pathname);
    const path = [basePath, encodedKey].filter(Boolean).join("/");
    return {
        url: `${endpoint.protocol}//${host}/${path}`,
        host,
        canonicalUri: `/${path}`,
    };
}

async function ensureNativeCspForEndpoint(endpoint: string) {
    if (IS_WEB) return true;
    if (typeof VencordNative === "undefined") return true;
    if (!settings.store.autoRequestNativeCspOverride) return true;

    const { origin } = normalizeEndpoint(endpoint);

    try {
        const allowed = await VencordNative.csp.isDomainAllowed(origin, ["connect-src"]);
        if (allowed) return true;

        if (cspPromptedOrigins.has(origin)) return false;
        cspPromptedOrigins.add(origin);

        const result = await VencordNative.csp.requestAddOverride(origin, ["connect-src"], "S3Upload");
        if (result === "ok") {
            showToast(`S3Upload: Allowed ${origin} in CSP. Fully restart Discord/Vesktop.`, Toasts.Type.SUCCESS);
        } else {
            showToast(`S3Upload: CSP allow was not granted for ${origin}.`, Toasts.Type.FAILURE);
        }
    } catch (error) {
        logger.error("Failed to request native CSP override", error);
    }

    return false;
}

function canonicalQuery(params: Record<string, string | null>) {
    return Object.entries(params)
        .map(([k, v]) => [encodeRfc3986(k), v == null ? null : encodeRfc3986(v)] as const)
        .sort((a, b) => {
            if (a[0] < b[0]) return -1;
            if (a[0] > b[0]) return 1;
            const av = a[1] ?? "";
            const bv = b[1] ?? "";
            if (av < bv) return -1;
            if (av > bv) return 1;
            return 0;
        })
        .map(([k, v]) => v == null ? k : `${k}=${v}`)
        .join("&");
}

function toAmzDate(date = new Date()) {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { amzDate: iso, shortDate: iso.slice(0, 8) };
}

function hex(bytes: ArrayBuffer) {
    return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string) {
    return hex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

async function hmac(key: ArrayBuffer | Uint8Array | string, data: string) {
    const rawKey = typeof key === "string" ? enc.encode(key) : key instanceof Uint8Array ? key : new Uint8Array(key);
    const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

async function getSigningKey(secret: string, shortDate: string, region: string, service = "s3") {
    const kDate = await hmac(`AWS4${secret}`, shortDate);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    return hmac(kService, "aws4_request");
}

async function signedS3Request(
    method: "POST" | "DELETE",
    key: string,
    queryParams: Record<string, string | null>,
    body?: string
) {
    const { bucket, region } = getEndpointConfig();
    const { accessKeyId, secretAccessKey } = getCredentials();
    const { url, host, canonicalUri } = buildS3Target(bucket, key);
    const canonicalQueryString = canonicalQuery(queryParams);
    const requestUrl = canonicalQueryString ? `${url}?${canonicalQueryString}` : url;

    const { amzDate, shortDate } = toAmzDate();
    const payload = body ?? "";
    const payloadHash = await sha256Hex(payload);
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = [
        `host:${host}`,
        `x-amz-content-sha256:${payloadHash}`,
        `x-amz-date:${amzDate}`,
        "",
    ].join("\n");

    const scope = `${shortDate}/${region}/s3/aws4_request`;
    const canonicalRequest = [
        method,
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        await sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = await getSigningKey(secretAccessKey, shortDate, region);
    const signature = hex(await hmac(signingKey, stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers: Record<string, string> = {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        Authorization: authorization,
    };

    if (body != null) headers["Content-Type"] = "application/xml";

    return fetch(requestUrl, {
        method,
        headers,
        body,
    });
}

async function presignUrl(
    method: "PUT" | "GET" | "POST" | "DELETE",
    key: string,
    expires: number,
    extraParams: Record<string, string | null> = {},
    signedPayloadHash = "UNSIGNED-PAYLOAD"
) {
    const { bucket, region } = getEndpointConfig();
    const { accessKeyId, secretAccessKey } = getCredentials();
    const { url, host, canonicalUri } = buildS3Target(bucket, key);
    const { amzDate, shortDate } = toAmzDate();

    const scope = `${shortDate}/${region}/s3/aws4_request`;
    const query = canonicalQuery({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${accessKeyId}/${scope}`,
        "X-Amz-Date": amzDate,
        "X-Amz-Expires": String(Math.max(1, Math.min(expires, 604800))),
        "X-Amz-SignedHeaders": "host",
        ...extraParams,
    });

    const canonicalRequest = [method, canonicalUri, query, `host:${host}\n`, "host", signedPayloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
    const signingKey = await getSigningKey(secretAccessKey, shortDate, region);
    const signature = hex(await hmac(signingKey, stringToSign));
    return `${url}?${query}&X-Amz-Signature=${signature}`;
}

function buildDirectObjectUrl(key: string) {
    const { bucket } = getEndpointConfig();
    const endpoint = normalizeEndpoint(settings.store.endpoint);
    const encodedKey = encodeKeyPath(key);
    const template = settings.store.publicUrlTemplate.trim();

    if (template) {
        return template
            .replaceAll("{endpoint}", endpoint.origin)
            .replaceAll("{bucket}", bucket)
            .replaceAll("{key}", encodedKey);
    }

    return buildS3Target(bucket, key).url;
}

function applyProgressToUpload(upload: any, ratio: number) {
    const normalized = Math.max(0, Math.min(1, ratio));
    const percent = normalized * 100;

    // Discord internals rename these occasionally; try common shapes.
    const candidates = [
        upload,
        upload?.item,
        upload?.upload,
        upload?.uploader,
        upload?.item?.upload,
    ].filter(Boolean);

    for (const target of candidates) {
        try { target.percent = percent; } catch { }
        try { target.progress = normalized; } catch { }
        try { target.uploadProgress = normalized; } catch { }
        try { target.bytesUploaded = Math.floor((upload?.item?.file?.size ?? 0) * normalized); } catch { }

        if (typeof target.setPercent === "function") {
            try { target.setPercent(percent); } catch { }
        }
        if (typeof target.setProgress === "function") {
            try { target.setProgress(normalized); } catch { }
        }
        if (typeof target.onProgress === "function") {
            try { target.onProgress(percent); } catch { }
        }
    }
}

async function putFileWithProgress(
    url: string,
    file: File,
    uploadRef?: any,
    onProgress?: (ratio: number, loaded: number, total: number) => void,
    abortHandle?: { abort?: () => void; aborted?: boolean; }
) {
    await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const uploadBody: Blob = file.slice(0, file.size);
        const stallMs = Math.max(10, Number(settings.store.uploadStallTimeoutSec || 45)) * 1000;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;

        const clearStallTimer = () => {
            if (stallTimer) {
                clearTimeout(stallTimer);
                stallTimer = null;
            }
        };
        const armStallTimer = () => {
            clearStallTimer();
            stallTimer = setTimeout(() => {
                vlog("S3 upload stalled; aborting request");
                try { xhr.abort(); } catch { }
                reject(new Error(`S3 upload stalled (no progress for ${Math.floor(stallMs / 1000)}s)`));
            }, stallMs);
        };

        if (abortHandle) {
            abortHandle.abort = () => {
                abortHandle.aborted = true;
                xhr.abort();
            };
        }
        xhr.open("PUT", url, true);
        armStallTimer();

        xhr.onreadystatechange = () => {
            vlog("S3 xhr state", { readyState: xhr.readyState, status: xhr.status });
        };

        xhr.upload.onprogress = e => {
            if (!e.lengthComputable) return;
            armStallTimer();
            const ratio = e.loaded / e.total;
            applyProgressToUpload(uploadRef, ratio);
            onProgress?.(ratio, e.loaded, e.total);
        };

        xhr.onload = () => {
            clearStallTimer();
            if (xhr.status >= 200 && xhr.status < 300) {
                applyProgressToUpload(uploadRef, 1);
                resolve();
            } else {
                reject(new Error(`S3 upload failed (${xhr.status})`));
            }
        };
        xhr.onerror = () => {
            clearStallTimer();
            reject(new Error("S3 upload failed (network error)"));
        };
        xhr.onabort = () => {
            clearStallTimer();
            reject(new Error("S3 upload aborted"));
        };
        xhr.send(uploadBody);
    });
}

function getHeaderCaseInsensitive(xhr: XMLHttpRequest, key: string) {
    const lower = key.toLowerCase();
    const raw = xhr.getAllResponseHeaders();
    for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        if (k === lower) return line.slice(idx + 1).trim();
    }
    return null;
}

async function putPartWithProgress(
    url: string,
    body: Blob,
    uploadRef?: any,
    onProgress?: (ratio: number, loaded: number, total: number) => void,
    abortHandle?: { abort?: () => void; aborted?: boolean; }
) {
    return await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        if (abortHandle) {
            abortHandle.abort = () => {
                abortHandle.aborted = true;
                xhr.abort();
            };
        }
        xhr.open("PUT", url, true);

        xhr.upload.onprogress = e => {
            if (!e.lengthComputable) return;
            const ratio = e.loaded / e.total;
            applyProgressToUpload(uploadRef, ratio);
            onProgress?.(ratio, e.loaded, e.total);
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const etag = getHeaderCaseInsensitive(xhr, "etag");
                if (!etag) {
                    reject(new Error("Multipart upload failed: missing ETag in part response"));
                    return;
                }
                resolve(etag.replace(/^W\//, "").replace(/^"|"$/g, ""));
            } else {
                vlog("Multipart part non-2xx response", {
                    status: xhr.status,
                    statusText: xhr.statusText,
                    responseText: xhr.responseText?.slice?.(0, 300) ?? "",
                });
                reject(new Error(`Multipart part upload failed (${xhr.status})`));
            }
        };
        xhr.onerror = () => reject(new Error("Multipart part upload failed (network error)"));
        xhr.onabort = () => reject(new Error("Multipart part upload aborted"));
        xhr.send(body);
    });
}

function parseXmlTag(xml: string, tagName: string) {
    const re = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
    const m = re.exec(xml);
    return m?.[1]?.trim() ?? null;
}

async function initiateMultipartUpload(key: string) {
    let res: Response;
    try {
        res = await signedS3Request("POST", key, { uploads: "" });
    } catch (error) {
        const msg = String((error as any)?.message ?? error ?? "");
        if (/Failed to fetch|CORS|preflight|network/i.test(msg)) {
            throw new Error("Initiate multipart failed due to CORS preflight. Allow POST/OPTIONS and required headers for this bucket origin.");
        }
        throw error;
    }
    if (!res.ok) throw new Error(`Initiate multipart failed (${res.status} ${res.statusText})`);
    const xml = await res.text();
    const uploadId = parseXmlTag(xml, "UploadId");
    if (!uploadId) throw new Error("Initiate multipart failed: missing UploadId");
    return uploadId;
}

async function completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]) {
    const body = [
        "<CompleteMultipartUpload>",
        ...parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`),
        "</CompleteMultipartUpload>",
    ].join("");

    const res = await signedS3Request("POST", key, { uploadId }, body);
    if (!res.ok) throw new Error(`Complete multipart failed (${res.status} ${res.statusText})`);
}

async function abortMultipartUpload(key: string, uploadId: string) {
    try {
        await signedS3Request("DELETE", key, { uploadId });
    } catch { }
}

function toMiBBytes(mib: number) {
    return Math.max(1, Math.floor(mib * 1024 * 1024));
}

async function uploadMultipartToS3(
    file: File,
    key: string,
    uploadRef?: any,
    onProgress?: (ratio: number, loaded: number, total: number) => void,
    abortHandle?: { abort?: () => void; aborted?: boolean; }
) {
    const partSize = toMiBBytes(settings.store.multipartPartSizeMiB || 95);
    const total = file.size;
    const partCount = Math.ceil(total / partSize);
    if (partCount > 10_000) {
        throw new Error("Multipart upload requires too many parts; increase part size");
    }

    const uploadId = await initiateMultipartUpload(key);
    const parts: MultipartPart[] = [];
    let uploadedBytes = 0;

    try {
        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
            if (abortHandle?.aborted) throw new Error("Multipart upload aborted");

            const start = (partNumber - 1) * partSize;
            const end = Math.min(start + partSize, total);
            const partBlob = file.slice(start, end);
            const partTotal = end - start;

            vlog("Multipart uploading part", { partNumber, partCount, partBytes: partTotal });

            const partUrl = await presignUrl("PUT", key, settings.store.presignedPutExpiresSec, {
                uploadId,
                partNumber: String(partNumber),
            });

            const etag = await putPartWithProgress(
                partUrl,
                partBlob,
                uploadRef,
                (ratio, loaded) => {
                    const absoluteLoaded = uploadedBytes + Math.floor(loaded);
                    const overallRatio = total > 0 ? absoluteLoaded / total : 1;
                    onProgress?.(overallRatio, absoluteLoaded, total);
                    if (settings.store.verbose) {
                        vlog("Multipart progress", {
                            partNumber,
                            partRatio: Number(ratio.toFixed(4)),
                            absoluteLoaded,
                            total,
                        });
                    }
                },
                abortHandle
            );

            uploadedBytes += partTotal;
            onProgress?.(uploadedBytes / total, uploadedBytes, total);
            parts.push({ partNumber, etag });
        }

        await completeMultipartUpload(key, uploadId, parts);
    } catch (error) {
        await abortMultipartUpload(key, uploadId);
        throw error;
    }
}

async function uploadToS3(
    file: File,
    uploadRef?: any,
    onProgress?: (ratio: number, loaded: number, total: number) => void,
    abortHandle?: { abort?: () => void; aborted?: boolean; }
) {
    assertConfigured();
    const endpoint = settings.store.endpoint.trim();

    if (!await ensureNativeCspForEndpoint(endpoint)) {
        throw new Error(`Endpoint is blocked by native CSP: ${normalizeEndpoint(endpoint).origin}. Allow it and fully restart Discord/Vesktop.`);
    }

    const key = getObjectKey(file.name);

    vlog(`Uploading ${file.name} to ${key}`);
    const shouldMultipart =
        settings.store.useMultipartForLargeFiles &&
        file.size >= toMiBBytes(settings.store.multipartThresholdMiB || 95);

    if (shouldMultipart) {
        await uploadMultipartToS3(file, key, uploadRef, onProgress, abortHandle);
    } else {
        const putUrl = await presignUrl("PUT", key, settings.store.presignedPutExpiresSec);
        try {
            await putFileWithProgress(putUrl, file, uploadRef, onProgress, abortHandle);
        } catch (error) {
            const msg = String((error as any)?.message ?? error ?? "");
            const isLikelyCorsFailure = /network error|Failed to fetch|CORS|preflight|access control/i.test(msg);
            const canFallbackToMultipart = settings.store.useMultipartForLargeFiles;

            if (!isLikelyCorsFailure || !canFallbackToMultipart) {
                throw error;
            }

            vlog("Single-part upload failed; retrying with multipart fallback", {
                file: file.name,
                size: file.size,
                reason: msg,
            });
            await uploadMultipartToS3(file, key, uploadRef, onProgress, abortHandle);
        }
    }

    const linkMode = getEffectiveLinkMode();
    const url = linkMode === "signedGet"
        ? await presignUrl("GET", key, settings.store.signedGetExpiresSec)
        : buildDirectObjectUrl(key);

    return { key, url };
}

function makeUploadUiMessage(channelId: string) {
    return {
        channelId,
        id: `${Date.now()}${Math.floor(Math.random() * 10_000)}`,
    };
}

function makeUiUploadFile(file: UploadFile) {
    const id = file.sourceUpload?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const item = file.sourceUpload?.item ?? { file: file.nativeFile };
    item.progress = 0;

    return {
        ...file.sourceUpload,
        id,
        item,
        loaded: 0,
        currentSize: file.size,
        status: "UPLOADING",
        isImage,
        isVideo,
    };
}

function makeUiUploadAggregate(file: UploadFile, uiFile: any) {
    return {
        id: uiFile.id,
        items: [uiFile],
        loaded: 0,
        total: file.size,
        currentSize: file.size,
        totalPostCompressionSize: file.size,
        progress: 0,
        progressRatio: 0,
        percent: 0,
        rate: 0,
        hasVideo: uiFile.isVideo,
        hasImage: uiFile.isImage,
        attachmentsCount: 1,
    };
}

function dispatchUploadStart(channelId: string, aggregate: any, uploader: any, message: any) {
    FluxDispatcher.dispatch({
        type: "UPLOAD_START",
        channelId,
        file: aggregate,
        uploader,
        message,
    });
}

function dispatchUploadProgress(channelId: string, aggregate: any) {
    FluxDispatcher.dispatch({
        type: "UPLOAD_PROGRESS",
        channelId,
        file: aggregate,
    });
}

function dispatchUploadComplete(channelId: string, aggregate: any, aborted = false) {
    FluxDispatcher.dispatch({
        type: "UPLOAD_COMPLETE",
        channelId,
        file: aggregate,
        aborted,
    });
}

function dispatchUploadFail(channelId: string, aggregate: any, messageId?: string) {
    FluxDispatcher.dispatch({
        type: "UPLOAD_FAIL",
        channelId,
        file: aggregate,
        messageId,
        shouldSendNotification: true,
    });
}

function asUploadFile(upload: any, channelId: string): UploadFile | null {
    const file = upload?.item?.file as File | undefined;
    if (!file) return null;

    return {
        name: file.name,
        size: file.size,
        type: file.type,
        destination: channelId,
        nativeFile: file,
        sourceUpload: upload,
    };
}

function getUploadHistory(): S3UploadHistoryItem[] {
    try {
        const parsed = JSON.parse(settings.store.historyJson || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function appendUploadHistory(item: S3UploadHistoryItem) {
    const history = getUploadHistory();
    history.unshift(item);
    settings.store.historyJson = JSON.stringify(history.slice(0, 300));
}

function getGuildUploadLimit(guildId?: string) {
    void guildId;
    return 10 * 1024 * 1024;
}

function shouldUseS3(uploadFile: UploadFile, guildId?: string) {
    if (settings.store.uploadEverything) return true;
    return uploadFile.size >= getGuildUploadLimit(guildId);
}

function getTotalUploadSize(files: UploadFile[]) {
    return files.reduce((sum, file) => sum + file.size, 0);
}

function shouldBypassDiscordFileChecks() {
    return isConfigured();
}

function openUploadPrompt(file: UploadFile) {
    return new Promise<boolean>(resolve => {
        let done = false;
        const close = (result: boolean) => {
            if (done) return;
            done = true;
            resolve(result);
        };

        const fileType = file.type?.split("/")?.[0] ?? "file";
        const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);

        Alerts.show({
            title: file.name,
            body: <Forms.FormText>Upload this {fileType} ({fileSizeMB} MB) to S3 and send the share link?</Forms.FormText>,
            confirmText: "Upload to S3",
            cancelText: "Cancel",
            onConfirm: () => close(true),
            onCloseCallback: () => close(false),
        });
    });
}

async function uploadAndShare(files: UploadFile[], messageContent: string) {
    const links: string[] = [];

    for (const file of files) {
        if (!settings.store.autoUpload) {
            const ok = await openUploadPrompt(file);
            if (!ok) continue;
        }

        const uiFile = makeUiUploadFile(file);
        const aggregate = makeUiUploadAggregate(file, uiFile);
        const abortHandle: { abort?: () => void; aborted?: boolean; } = {};
        const uploaderStub: any = {
            _file: aggregate,
            _aborted: false,
            abort: () => {
                uploaderStub._aborted = true;
                abortHandle.abort?.();
            },
            cancel: () => {
                uploaderStub.abort();
            }
        };
        const uiMessage = makeUploadUiMessage(file.destination);
        dispatchUploadStart(file.destination, aggregate, uploaderStub, uiMessage);

        try {
            let lastProgressLogTs = 0;
            const { key, url } = await uploadToS3(
                file.nativeFile,
                uiFile,
                (ratio, loaded, total) => {
                    const normalized = Math.max(0, Math.min(1, ratio));
                    const percent = normalized * 100;

                    uiFile.loaded = loaded;
                    uiFile.currentSize = total;
                    uiFile.total = total;
                    uiFile.progress = normalized;
                    uiFile.progressRatio = normalized;
                    uiFile.percent = percent;
                    uiFile.item.progress = percent;
                    uiFile.item.progressRatio = normalized;
                    uiFile.item.percent = percent;
                    uiFile.item.loaded = loaded;
                    uiFile.item.total = total;

                    aggregate.loaded = loaded;
                    aggregate.total = total;
                    aggregate.progress = percent;
                    aggregate.progressRatio = normalized;
                    aggregate.percent = percent;
                    aggregate.currentSize = total;
                    aggregate.rate = 0;
                    dispatchUploadProgress(file.destination, aggregate);

                    const now = Date.now();
                    if (now - lastProgressLogTs >= 500) {
                        lastProgressLogTs = now;
                        vlog("S3 progress", {
                            file: file.name,
                            loaded,
                            total,
                            ratio: Number(normalized.toFixed(4)),
                            percent: Number(percent.toFixed(2)),
                        });
                    }
                },
                abortHandle
            );
            links.push(withS3MetadataFragment(url, file.nativeFile, key));
            uiFile.status = "COMPLETED";
            uiFile.progress = 1;
            uiFile.progressRatio = 1;
            uiFile.percent = 100;
            uiFile.item.progress = 100;
            uiFile.item.progressRatio = 1;
            uiFile.item.percent = 100;
            aggregate.loaded = aggregate.total;
            aggregate.progress = 100;
            aggregate.progressRatio = 1;
            aggregate.percent = 100;
            dispatchUploadComplete(file.destination, aggregate, false);

            appendUploadHistory({
                uploadedAt: new Date().toUTCString(),
                fileName: file.name,
                fileSize: file.size,
                objectKey: key,
                url,
            });
        } catch (error) {
            if (uploaderStub._aborted || abortHandle.aborted) {
                uiFile.status = "ABORTED";
                dispatchUploadComplete(file.destination, aggregate, true);
                continue;
            }
            uiFile.status = "ERROR";
            dispatchUploadFail(file.destination, aggregate, uiMessage.id);
            throw error;
        }
    }

    if (!links.length) return;

    const content = messageContent.trim()
        ? `${messageContent}\n${links.join("\n")}`
        : links.join("\n");

    sendMessage(files[0].destination, {
        content,
        validNonShortcutEmojis: [],
    });

    showToast(`Uploaded ${links.length} file(s) to S3`, Toasts.Type.SUCCESS);
}

async function handleAttachmentsToUpload({
    channelId,
    guildId,
    uploads,
    messageContent,
}: {
    channelId: string;
    guildId?: string;
    uploads: any[];
    messageContent: string;
}) {
    if (!isConfigured() || !Array.isArray(uploads) || uploads.length === 0) return false;
    vlog("handleAttachmentsToUpload invoked", { channelId, guildId, uploadCount: uploads.length });

    const converted = uploads
        .map(upload => asUploadFile(upload, channelId))
        .filter(Boolean) as UploadFile[];

    if (!converted.length) return false;

    const limit = getGuildUploadLimit(guildId);
    const totalSize = getTotalUploadSize(converted);
    const isTotalTooLarge = totalSize > limit;
    const selected = converted.filter(file => shouldUseS3(file, guildId));
    if (!selected.length && !isTotalTooLarge) return false;

    const isMixed = selected.length > 0 && selected.length !== converted.length;
    const toUpload = isTotalTooLarge || isMixed ? converted : selected;

    if (isTotalTooLarge) {
        showToast("Upload total exceeds Discord limit. Sending attachments through S3.", Toasts.Type.MESSAGE);
    } else if (isMixed) {
        showToast("Mixed upload detected. Sending all attachments through S3 for compatibility.", Toasts.Type.MESSAGE);
    }

    try {
        showToast(`S3Upload intercept: ${toUpload.length} file(s)`, Toasts.Type.MESSAGE);
        await uploadAndShare(toUpload, messageContent || "");
    } catch (error) {
        logger.error("S3 upload failed", error);
        showToast("S3 upload failed. Check endpoint/bucket/key settings.", Toasts.Type.FAILURE);
    }

    return true;
}

function removeUrlsFromContentByBase(content: string, removedBaseUrls: Set<string>) {
    if (!content || !removedBaseUrls.size) return content;
    return content
        .split("\n")
        .map(line => {
            const urls = extractUrls(line);
            let next = line;
            for (const url of urls) {
                if (!removedBaseUrls.has(stripHash(url))) continue;
                next = next.replace(url, " ");
            }
            return next.replace(/\s+/g, " ").trim();
        })
        .filter(Boolean)
        .join("\n");
}

async function handleVirtualAttachmentDelete(channelId: string, messageId: string, nextAttachments: any[]) {
    const message = MessageStore.getMessage(channelId, messageId) as any;
    if (!message || typeof message.content !== "string") return false;

    const s3UrlsInContent = extractUrls(message.content).filter(shouldTreatAsS3Link);
    if (!s3UrlsInContent.length) return false;

    const keepUrls = new Set((Array.isArray(nextAttachments) ? nextAttachments : [])
        .map(a => a?.url)
        .filter(Boolean)
        .map(stripHash));
    const removed = s3UrlsInContent
        .map(stripHash)
        .filter(url => !keepUrls.has(url));
    if (!removed.length) return false;

    const newContent = removeUrlsFromContentByBase(message.content, new Set(removed));
    const removedKeys = new Set(
        s3UrlsInContent
            .map(url => ({ base: stripHash(url), meta: parseS3Metadata(url) }))
            .filter(x => removed.includes(x.base))
            .map(x => x.meta?.objectKey)
            .filter(Boolean) as string[]
    );

    if (!newContent.trim()) {
        await RestAPI.del({
            url: Constants.Endpoints.MESSAGE(channelId, messageId),
            oldFormErrors: true,
            rejectWithError: false,
        });
    } else {
        await RestAPI.patch({
            url: Constants.Endpoints.MESSAGE(channelId, messageId),
            body: { content: newContent },
            oldFormErrors: true,
            rejectWithError: false,
        });
    }

    for (const key of removedKeys) {
        try {
            const delUrl = await presignUrl("DELETE", key, settings.store.presignedPutExpiresSec);
            await fetch(delUrl, { method: "DELETE" });
        } catch (error) {
            vlog("S3 object delete failed", { key, error: String(error) });
        }
    }

    showToast(
        `Removed ${removed.length} S3 link attachment(s)${removedKeys.size ? `, deleted ${removedKeys.size} object(s)` : ""}`,
        Toasts.Type.SUCCESS
    );
    return true;
}

export default definePlugin({
    name: "S3Upload",
    description: "Upload large attachments to S3-compatible storage and send links",
    authors: [Devs.Ven],
    settings,

    patches: [
        {
            find: 'location:"getGuildMaxFileSize"',
            replacement: [
                {
                    match: /return Array\.from\(e\)\.some\(e=>e\.size>n\)/,
                    replace: "return $self.shouldBypassDiscordFileChecks()?false:Array.from(e).some(e=>e.size>n)",
                },
                {
                    match: /return R\(e\)>b\(\)/,
                    replace: "return $self.shouldBypassDiscordFileChecks()?false:R(e)>b()",
                }
            ]
        },
        {
            find: "}renderStickersAccessories(",
            replacement: [
                {
                    match: /renderAttachments\(\i\){.+?{attachments:(\i).+?;/,
                    replace: (m, attachments) => `${m}${attachments}=$self.injectS3LinksForRender(${attachments},arguments[0]);`,
                    noWarn: false
                }
            ]
        },
        {
            find: 'noStyleAndInteraction?(0,r.jsx)("span",{title:p,children:f},_.key):(0,r.jsx)(a.A,{title:p,href:t.target',
            replacement: {
                match: /return _.noStyleAndInteraction\?\(0,r\.jsx\)\("span",\{title:p,children:f\},_.key\):\(0,r\.jsx\)\(a\.A,\{title:p,href:t\.target,trusted:h,onClick:m,messageId:_.messageId,channelId:_.channelId,children:f\},_.key\)/,
                replace: "if($self.shouldHideRenderedLink(t.target))return null;return _.noStyleAndInteraction?(0,r.jsx)(\"span\",{title:p,children:f},_.key):(0,r.jsx)(a.A,{title:p,href:t.target,trusted:h,onClick:m,messageId:_.messageId,channelId:_.channelId,children:f},_.key)",
                noWarn: false
            }
        },
        {
            find: "async patchMessageAttachments(e,t,n){",
            replacement: {
                match: /async patchMessageAttachments\((\i),(\i),(\i)\)\{/,
                replace: "async patchMessageAttachments($1,$2,$3){if(await $self.handleVirtualAttachmentDelete($1,$2,$3))return;"
            }
        },
        {
            find: "attachmentsToUpload:v,onAttachmentUploadError:R",
            replacement: [
                {
                    match: /let t=await \(0,G\.L\)\(\{channelId:e,nonce:J,items:v,message:et,shouldUploadFailureSendNotification:!n\.doNotNotifyOnError&&void 0\}\);/,
                    replace: "if(await $self.handleAttachmentsToUpload({channelId:e,guildId:k?.guild_id,uploads:v,messageContent:a}))return;let t=await (0,G.L)({channelId:e,nonce:J,items:v,message:et,shouldUploadFailureSendNotification:!n.doNotNotifyOnError&&void 0});"
                },
                {
                    match: /if\(null!=v&&v\.length>0\)try\{let t=await \(0,(\i)\.(\i)\)\(\{channelId:e,nonce:J,items:v,message:et,shouldUploadFailureSendNotification:!n\.doNot/,
                    replace: "if(null!=v&&v.length>0)try{if(await $self.handleAttachmentsToUpload({channelId:e,guildId:k?.guild_id,uploads:v,messageContent:a}))return;let t=await (0,$1.$2)({channelId:e,nonce:J,items:v,message:et,shouldUploadFailureSendNotification:!n.doNot",
                    noWarn: false
                },
                {
                    match: /if\(null!=(\i)&&\1\.length>0\)try\{let (\i)=await \(0,(\i)\.(\i)\)\(\{channelId:(\i),nonce:(\i),items:\1,message:(\i),/,
                    replace: "if(null!=$1&&$1.length>0)try{if(await $self.handleAttachmentsToUpload({channelId:$5,guildId:k?.guild_id,uploads:$1,messageContent:a}))return;let $2=await (0,$3.$4)({channelId:$5,nonce:$6,items:$1,message:$7,",
                    noWarn: false
                }
            ]
        }
    ],

    shouldBypassDiscordFileChecks,
    handleAttachmentsToUpload,
    injectS3LinksForRender,
    stripS3LinksFromContent,
    shouldHideRenderedLink,
    handleVirtualAttachmentDelete,

    start() {
        logger.info("S3Upload started");
        showToast(`S3Upload loaded (patch mode, configured=${isConfigured()})`, Toasts.Type.MESSAGE);
    },

    stop() {
        logger.info("S3Upload stopped");
    },
});
