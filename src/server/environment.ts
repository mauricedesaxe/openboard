export type Environment = {
  APP_ENV: string;
  APP_URL: string;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTERSTACK_INCIDENT_API_TOKEN?: string;
  BETTERSTACK_INCIDENT_REQUESTER_EMAIL?: string;
  DB: D1Database;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_TRANSPORT: string;
  FILES: R2Bucket;
  RESEND_API_KEY?: string;
  VERSION?: WorkerVersionMetadata;
};
