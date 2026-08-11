import { z } from "zod";

export const MAX_STORED_FILE_BYTES = 10_000_000;
const MAX_STORED_FILE_BASE64_LENGTH = Math.ceil(MAX_STORED_FILE_BYTES / 3) * 4;

export const storedFileUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(1).max(MAX_STORED_FILE_BASE64_LENGTH),
});

export type StoredFileId = string & { readonly __brand: "StoredFileId" };
export const storedFileIdSchema = z
  .uuid()
  .transform((value) => value as StoredFileId);
export type StoredFileUpload = z.infer<typeof storedFileUploadSchema>;
