import { randomUUID } from "crypto";
import prisma from "../src/lib/prisma";
import { finishToolRunSuccess, getOrStartToolRun } from "../src/lib/idempotency";

const run = async () => {
  const vendor_uuid = `vendor_${randomUUID()}`;
  const endpoint = "/vapi/create-job";
  const call_id = `call_${randomUUID()}`;

  const first = await getOrStartToolRun(vendor_uuid, endpoint, call_id);
  if (first.replayResult) {
    throw new Error("Unexpected replay on first call");
  }

  const resultJson = { ok: true, job_uuid: "job_demo" };
  await finishToolRunSuccess(first.run.id, resultJson);

  const second = await getOrStartToolRun(vendor_uuid, endpoint, call_id);
  if (!second.replayResult) {
    throw new Error("Expected replay result on second call");
  }

  const matches = JSON.stringify(second.replayResult) === JSON.stringify(resultJson);
  if (!matches) {
    throw new Error("Replay result does not match stored payload");
  }

  console.log("PASS - idempotency replay");
};

run()
  .catch((err) => {
    console.error(`FAIL - idempotency replay: ${err.message}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
