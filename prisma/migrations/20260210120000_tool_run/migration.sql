-- CreateTable
CREATE TABLE "ToolRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendor_uuid" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result_json" TEXT,
    "error_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolRun_vendor_uuid_endpoint_call_id_key" ON "ToolRun"("vendor_uuid", "endpoint", "call_id");
