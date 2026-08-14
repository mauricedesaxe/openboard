import { expect, test } from "vitest";

import { uploadProposalFileSchema } from "../src/shared/submissions";

test("rejects oversized file payloads before decoding", () => {
  expect(
    uploadProposalFileSchema.safeParse({
      slug: "oversized-file",
      cfpId: crypto.randomUUID(),
      clientDraftId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      fieldKey: "outline",
      customAnswers: {},
      fileName: "outline.pdf",
      contentType: "application/pdf",
      contentBase64: "A".repeat(13_333_337),
    }).success,
  ).toBe(false);
});
