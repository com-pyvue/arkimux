// Conformance instrumentation, also prepended to the real retained worker.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import childProcess from 'node:child_process';
import { url as inspectorUrl } from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
if (inspectorUrl()) throw new Error('An IDE/inspector must not participate in this proof');
const forbidden = () => { throw new Error('HTTP/provider access is forbidden in headless conformance'); };
http.Server.prototype.listen = forbidden;
https.Server.prototype.listen = forbidden;
http.request = http.get = https.request = https.get = forbidden;
http2.createServer = http2.createSecureServer = http2.connect = forbidden;
globalThis.fetch = forbidden;
// Native model CLIs are forbidden too; only the real retained worker may fork.
childProcess.spawn = childProcess.spawnSync = childProcess.exec = childProcess.execSync = forbidden;
childProcess.execFile = childProcess.execFileSync = forbidden;
syncBuiltinESMExports();
