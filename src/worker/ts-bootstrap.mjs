// Só dev/testes: o worker em .ts. `--import tsx` em `execArgv` do Worker não vale dentro da thread
// (a entrada .ts falha ao resolver `./x.js`), então o tsx é registrado aqui e o worker real é importado depois.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
await import(workerData.tsEntry);
