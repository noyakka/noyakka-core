export type ExtractedVapiArgs = {
  args: any;
  meta: {
    call_id?: string;
    tool_name?: string;
  };
};

const parseJsonIfString = (value: unknown) => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const collectMeta = (value: any, meta: ExtractedVapiArgs["meta"]) => {
  if (!value || typeof value !== "object") {
    return meta;
  }

  const callId =
    value.call_id ??
    value.callId ??
    value.tool_call_id ??
    value.toolCallId ??
    value.id ??
    value.toolCall?.id ??
    value.tool_call?.id;
  if (callId && !meta.call_id) {
    meta.call_id = String(callId);
  }

  const toolName =
    value.tool_name ??
    value.toolName ??
    value.name ??
    value.toolCall?.name ??
    value.tool_call?.name ??
    value.toolCall?.function?.name ??
    value.tool_call?.function?.name;
  if (toolName && !meta.tool_name) {
    meta.tool_name = String(toolName);
  }

  return meta;
};

const unwrapArgs = (value: unknown, depth: number, meta: ExtractedVapiArgs["meta"]): any => {
  if (depth >= 8) {
    return value;
  }

  const parsed = parseJsonIfString(value);
  if (parsed !== value) {
    return unwrapArgs(parsed, depth + 1, meta);
  }

  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  const obj = parsed as any;
  collectMeta(obj, meta);

  if (obj.args !== undefined) {
    return unwrapArgs(obj.args, depth + 1, meta);
  }
  if (obj.arguments !== undefined) {
    return unwrapArgs(obj.arguments, depth + 1, meta);
  }
  if (obj.input !== undefined) {
    return unwrapArgs(obj.input, depth + 1, meta);
  }
  if (obj.toolCall) {
    collectMeta(obj.toolCall, meta);
    if (obj.toolCall.function?.arguments !== undefined) {
      return unwrapArgs(obj.toolCall.function.arguments, depth + 1, meta);
    }
    if (obj.toolCall.args !== undefined) {
      return unwrapArgs(obj.toolCall.args, depth + 1, meta);
    }
    if (obj.toolCall.arguments !== undefined) {
      return unwrapArgs(obj.toolCall.arguments, depth + 1, meta);
    }
  }
  if (obj.tool_call) {
    collectMeta(obj.tool_call, meta);
    if (obj.tool_call.function?.arguments !== undefined) {
      return unwrapArgs(obj.tool_call.function.arguments, depth + 1, meta);
    }
    if (obj.tool_call.args !== undefined) {
      return unwrapArgs(obj.tool_call.args, depth + 1, meta);
    }
    if (obj.tool_call.arguments !== undefined) {
      return unwrapArgs(obj.tool_call.arguments, depth + 1, meta);
    }
  }

  // Vapi webhook wrappers can nest calls in message.toolCalls/toolCallList
  const messageToolCalls = obj.message?.toolCalls ?? obj.message?.toolCallList;
  if (Array.isArray(messageToolCalls) && messageToolCalls.length > 0) {
    const first = messageToolCalls[0];
    collectMeta(first, meta);
    if (first?.function?.arguments !== undefined) {
      return unwrapArgs(first.function.arguments, depth + 1, meta);
    }
    if (first?.arguments !== undefined) {
      return unwrapArgs(first.arguments, depth + 1, meta);
    }
  }

  // Some payloads expose tool calls at top-level
  const topToolCalls = obj.toolCalls ?? obj.toolCallList;
  if (Array.isArray(topToolCalls) && topToolCalls.length > 0) {
    const first = topToolCalls[0];
    collectMeta(first, meta);
    if (first?.function?.arguments !== undefined) {
      return unwrapArgs(first.function.arguments, depth + 1, meta);
    }
    if (first?.arguments !== undefined) {
      return unwrapArgs(first.arguments, depth + 1, meta);
    }
  }

  return obj;
};

export const extractVapiArgs = (raw: unknown): ExtractedVapiArgs => {
  const meta: ExtractedVapiArgs["meta"] = {};
  collectMeta(raw, meta);
  const args = unwrapArgs(raw, 0, meta);
  return { args, meta };
};
