/**
 * Ponto de entrada do worker_thread de conversão. Uma tarefa por vez: recebe um ConvertRequest,
 * responde com ConvertOutput ou com um erro serializado. Nunca escreve em stdout.
 */
import { parentPort } from "node:worker_threads";
import { Web2mdError } from "../errors.js";
import { runConvertRequest } from "./convert-core.js";
import type { ConvertRequest, WorkerErrorPayload, WorkerResponse } from "./protocol.js";
import type { ConvertOutput } from "./protocol.js";

function serializeError(err: unknown): WorkerErrorPayload {
  if (err instanceof Web2mdError) return { type: "web2md", code: err.code, message: err.message };
  if (err instanceof RangeError && /call stack/i.test(err.message)) return { type: "stack-overflow" };
  return { type: "internal", detail: err instanceof Error ? (err.stack ?? err.message) : String(err) };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: ConvertRequest) => {
    let response: WorkerResponse<ConvertOutput>;
    try {
      response = { ok: true, result: runConvertRequest(req) };
    } catch (err) {
      response = { ok: false, error: serializeError(err) };
    }
    port.postMessage(response);
  });
}
