import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapLocalOperator } from "./localOperatorBootstrap.ts";

export { bootstrapLocalOperator } from "./localOperatorBootstrap.ts";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrapLocalOperator().then((message) => console.log(message)).catch((error) => {
    console.error((error as Error).stack ?? String(error));
    process.exitCode = 1;
  });
}
