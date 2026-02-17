-- AlterTable
ALTER TABLE "OAuthState" ADD COLUMN "redirect_uri" TEXT NOT NULL DEFAULT 'https://noyakka-core.fly.dev/auth/servicem8/callback';
