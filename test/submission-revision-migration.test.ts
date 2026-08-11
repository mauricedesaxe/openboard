import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const migrationEnvironment = env as unknown as {
  MIGRATION_DB: D1Database;
  SUBMISSION_REVISION_MIGRATION: Parameters<typeof applyD1Migrations>[1];
};

test("upgrades existing proposals and keeps concurrent writes complete", async () => {
  await migrationEnvironment.MIGRATION_DB.batch([
    migrationEnvironment.MIGRATION_DB.prepare(
      "CREATE TABLE submissions (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "CREATE TABLE decisions (submission_id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "CREATE TABLE form_responses (submission_id TEXT PRIMARY KEY NOT NULL, answers_json TEXT NOT NULL)",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      `CREATE TRIGGER form_responses_require_editable_update
       BEFORE UPDATE OF answers_json ON form_responses
       BEGIN
         SELECT 1;
       END`,
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO submissions VALUES ('submission', 'active', 'Original')",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      "INSERT INTO decisions VALUES ('submission', 'pending')",
    ),
    migrationEnvironment.MIGRATION_DB.prepare(
      `INSERT INTO form_responses VALUES ('submission', '{"audience":"Original"}')`,
    ),
  ]);

  await applyD1Migrations(
    migrationEnvironment.MIGRATION_DB,
    migrationEnvironment.SUBMISSION_REVISION_MIGRATION,
  );

  const writes = [
    { title: "First", answers: '{"audience":"First"}', token: "first" },
    { title: "Second", answers: '{"audience":"Second"}', token: "second" },
  ];
  const results = await Promise.allSettled(
    writes.map(({ title, answers, token }) =>
      migrationEnvironment.MIGRATION_DB.batch([
        migrationEnvironment.MIGRATION_DB.prepare(
          `UPDATE submissions
           SET title = ?, revision = revision + 1, write_token = ?
           WHERE id = 'submission' AND revision = 1`,
        ).bind(title, token),
        migrationEnvironment.MIGRATION_DB.prepare(
          `UPDATE form_responses
           SET answers_json = ?, write_token = ?
           WHERE submission_id = 'submission'`,
        ).bind(answers, token),
      ]),
    ),
  );
  expect(results.map(({ status }) => status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);

  const saved = await migrationEnvironment.MIGRATION_DB.prepare(
    `SELECT submissions.title, submissions.revision,
            submissions.write_token AS submissionToken,
            form_responses.answers_json AS answers,
            form_responses.write_token AS responseToken
     FROM submissions
     INNER JOIN form_responses ON form_responses.submission_id = submissions.id`,
  ).first<{
    title: string;
    revision: number;
    submissionToken: string;
    answers: string;
    responseToken: string;
  }>();
  expect(saved).toEqual(
    expect.objectContaining({
      revision: 2,
      submissionToken: saved?.responseToken,
    }),
  );
  const winner = writes.find(({ token }) => token === saved?.submissionToken);
  expect(saved).toMatchObject({
    title: winner?.title,
    answers: winner?.answers,
  });
});
