export type Environment = {
  APP_ENV: string;
  APP_URL: string;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  DB: D1Database;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_TRANSPORT: string;
  FILES: R2Bucket;
};
