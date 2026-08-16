import { describe, expect, test } from "vitest";

import { matchesStoredFileContentType } from "../src/server/files/repository";

describe("stored file content type guards", () => {
  test("accepts a valid PDF header", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 content...");
    expect(matchesStoredFileContentType(bytes, "application/pdf")).toBe(true);
  });

  test("rejects a PDF with a missing signature", () => {
    const bytes = new TextEncoder().encode("Not a PDF file.");
    expect(matchesStoredFileContentType(bytes, "application/pdf")).toBe(false);
  });

  test("rejects a truncated PDF", () => {
    const bytes = new TextEncoder().encode("%PD");
    expect(matchesStoredFileContentType(bytes, "application/pdf")).toBe(false);
  });

  test("accepts a valid JPEG header", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(matchesStoredFileContentType(bytes, "image/jpeg")).toBe(true);
    const exif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]);
    expect(matchesStoredFileContentType(exif, "image/jpeg")).toBe(true);
  });

  test("rejects a fake JPEG with a wrong leading byte", () => {
    const bytes = new Uint8Array([0x00, 0xd8, 0xff, 0xe0]);
    expect(matchesStoredFileContentType(bytes, "image/jpeg")).toBe(false);
  });

  test("accepts a valid PNG header", () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    expect(matchesStoredFileContentType(bytes, "image/png")).toBe(true);
  });

  test("rejects a fake PNG with a single wrong byte", () => {
    const bytes = new Uint8Array([
      0x89, 0x51, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(matchesStoredFileContentType(bytes, "image/png")).toBe(false);
  });

  test("accepts a valid WebP header", () => {
    const header = new TextEncoder().encode("RIFF....WEBP");
    const bytes = new Uint8Array(header);
    expect(matchesStoredFileContentType(bytes, "image/webp")).toBe(true);
  });

  test("rejects a WebP with a wrong four-character subtype", () => {
    const header = new TextEncoder().encode("RIFF....WAVE");
    const bytes = new Uint8Array(header);
    expect(matchesStoredFileContentType(bytes, "image/webp")).toBe(false);
  });

  test("rejects a WebP with a wrong RIFF header", () => {
    const header = new TextEncoder().encode("RIFX....WEBP");
    const bytes = new Uint8Array(header);
    expect(matchesStoredFileContentType(bytes, "image/webp")).toBe(false);
  });

  test("rejects a truncated WebP header", () => {
    const header = new TextEncoder().encode("RIFF....WEB");
    const bytes = new Uint8Array(header);
    expect(matchesStoredFileContentType(bytes, "image/webp")).toBe(false);
  });

  test("accepts valid GIF headers in both legacy versions", () => {
    const gif87a = new TextEncoder().encode("GIF87a");
    const bytes87 = new Uint8Array(gif87a);
    expect(matchesStoredFileContentType(bytes87, "image/gif")).toBe(true);

    const gif89a = new TextEncoder().encode("GIF89a");
    const bytes89 = new Uint8Array(gif89a);
    expect(matchesStoredFileContentType(bytes89, "image/gif")).toBe(true);
  });

  test("rejects a GIF with a wrong version suffix", () => {
    const header = new TextEncoder().encode("GIF99a");
    const bytes = new Uint8Array(header);
    expect(matchesStoredFileContentType(bytes, "image/gif")).toBe(false);
  });

  test("rejects a truncated GIF header", () => {
    const header = new TextEncoder().encode("GIF87");
    const bytes = new Uint8Array(header);
    expect(matchesStoredFileContentType(bytes, "image/gif")).toBe(false);
  });

  test("rejects an unknown content type", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02]);
    expect(matchesStoredFileContentType(bytes, "video/mp4")).toBe(false);
    expect(matchesStoredFileContentType(bytes, "text/html")).toBe(false);
  });

  test("rejects empty bytes", () => {
    expect(matchesStoredFileContentType(new Uint8Array(), "image/png")).toBe(
      false,
    );
  });
});
