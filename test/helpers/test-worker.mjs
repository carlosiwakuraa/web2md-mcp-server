// Worker de teste para o WorkerPool (mesmo protocolo do convert-worker, sem jsdom: sobe em poucos ms).
import { parentPort, threadId } from "node:worker_threads";

parentPort.on("message", (req) => {
  switch (req.op) {
    case "echo":
      parentPort.postMessage({ ok: true, result: { threadId, value: req.value } });
      break;
    case "sleep": {
      const start = Date.now();
      setTimeout(() => parentPort.postMessage({ ok: true, result: { threadId, start, end: Date.now() } }), req.ms);
      break;
    }
    case "spin":
      for (;;) {
        // loop síncrono infinito: só terminate() resolve
      }
    case "oom": {
      const hold = [];
      for (;;) hold.push(new Array(100_000).fill(Math.random()));
    }
    case "fail":
      parentPort.postMessage({ ok: false, error: { type: "web2md", code: "EMPTY_CONTENT", message: "sem conteúdo" } });
      break;
    case "crash":
      process.exit(3);
  }
});
