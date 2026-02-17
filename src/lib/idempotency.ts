import prisma from "./prisma";

type ToolRunStatus = "STARTED" | "SUCCEEDED" | "FAILED";

export const getOrStartToolRun = async (
  vendor_uuid: string,
  endpoint: string,
  call_id: string
) => {
  const existing = await prisma.toolRun.findUnique({
    where: {
      vendor_uuid_endpoint_call_id: {
        vendor_uuid,
        endpoint,
        call_id,
      },
    },
  });

  if (existing) {
    if (existing.status === "SUCCEEDED") {
      let replayResult: unknown = existing.result_json;
      if (typeof existing.result_json === "string") {
        try {
          replayResult = JSON.parse(existing.result_json);
        } catch {
          replayResult = existing.result_json;
        }
      }
      return { run: existing, replayResult };
    }
    if (existing.status === "FAILED") {
      const updated = await prisma.toolRun.update({
        where: { id: existing.id },
        data: { status: "STARTED", error_code: null, result_json: null },
      });
      return { run: updated };
    }
    return { run: existing };
  }

  const run = await prisma.toolRun.create({
    data: {
      vendor_uuid,
      endpoint,
      call_id,
      status: "STARTED" as ToolRunStatus,
    },
  });

  return { run };
};

export const finishToolRunSuccess = async (runId: string, resultJson: unknown) => {
  let serialized: string | null = null;
  try {
    serialized = resultJson === undefined ? null : JSON.stringify(resultJson);
  } catch {
    serialized = null;
  }
  return prisma.toolRun.update({
    where: { id: runId },
    data: {
      status: "SUCCEEDED",
      result_json: serialized,
      error_code: null,
    },
  });
};

export const finishToolRunFailure = async (runId: string, errorCode: string) => {
  return prisma.toolRun.update({
    where: { id: runId },
    data: {
      status: "FAILED",
      error_code: errorCode,
    },
  });
};
