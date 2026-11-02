import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
await build({entryPoints:[path.join(root,'telemetry/events.ts')],outfile:path.join(root,'dist/events.js'),bundle:true,packages:'external',platform:'neutral',format:'esm',target:'es2022'});
