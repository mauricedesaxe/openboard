import type { UserId } from "../../shared/events";
import {
  MAX_STORED_FILE_BYTES,
  type StoredFileUpload,
} from "../../shared/files";

type PutStoredFileResult =
  | {
      ok: true;
      value: {
        record: {
          id: string;
          objectKey: string;
          fileName: string;
          contentType: string;
          sizeBytes: number;
          uploadedByUserId: UserId;
          createdAt: Date;
        };
      };
    }
  | { ok: false; error: "invalid_file" | "storage_failed" };

export async function putStoredFile(
  files: R2Bucket,
  uploadedByUserId: UserId,
  directory: string,
  input: StoredFileUpload,
  isValid: (bytes: Uint8Array, contentType: string) => boolean = () => true,
): Promise<PutStoredFileResult> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(input.contentBase64), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return { ok: false, error: "invalid_file" };
  }
  if (
    bytes.byteLength > MAX_STORED_FILE_BYTES ||
    !isValid(bytes, input.contentType)
  ) {
    return { ok: false, error: "invalid_file" };
  }

  const id = crypto.randomUUID();
  const objectKey = `${directory}/${id}`;
  try {
    await files.put(objectKey, bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { fileName: input.fileName },
    });
  } catch {
    return { ok: false, error: "storage_failed" };
  }

  return {
    ok: true,
    value: {
      record: {
        id,
        objectKey,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: bytes.byteLength,
        uploadedByUserId,
        createdAt: new Date(),
      },
    },
  };
}

export async function compensateStoredFile(
  files: R2Bucket,
  objectKey: string,
  event: string,
): Promise<void> {
  try {
    await files.delete(objectKey);
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event,
        objectKey,
        error:
          error instanceof Error
            ? error.message
            : "Unknown object-store failure",
      }),
    );
  }
}
