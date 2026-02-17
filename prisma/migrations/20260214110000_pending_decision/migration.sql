-- CreateTable
CREATE TABLE "PendingDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "job_uuid" TEXT NOT NULL,
    "allocation_uuid" TEXT,
    "servicem8_vendor_uuid" TEXT NOT NULL,
    "customer_mobile" TEXT NOT NULL,
    "tradie_mobile" TEXT NOT NULL,
    "flags_json" TEXT NOT NULL,
    "distance_km" REAL,
    "distance_band" TEXT,
    "template_a" TEXT NOT NULL,
    "template_b" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "resolved_action" TEXT,
    "resolved_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingDecision_job_uuid_key" ON "PendingDecision"("job_uuid");
