-- CreateTable
CREATE TABLE "OverrunSmsEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_allocation_uuid" TEXT NOT NULL,
    "target_allocation_uuid" TEXT,
    "target_job_uuid" TEXT NOT NULL,
    "sms_type" TEXT NOT NULL,
    "last_sms_sent_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "OverrunSmsEvent_source_allocation_uuid_target_job_uuid_sms_type_key"
ON "OverrunSmsEvent"("source_allocation_uuid", "target_job_uuid", "sms_type");
