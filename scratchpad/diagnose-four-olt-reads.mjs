import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
// Load an instrumented copy in memory only. Do not modify the deployed module.
let source = await readFile('/app/dist/huawei/verifyOnt.js', 'utf8');
source = source.replace(/from (["'])ssh2\1/g, `from 'file://${createRequire('/app/package.json').resolve('ssh2')}'`);
source = source.replace(/from (["'])\.\/([^"']+)\1/g,
  (_, quote, name) => `from ${quote}file:///app/dist/huawei/${name}${quote}`);
source = source.replace(
  'this.waiting.reject(new Error("OLT closed the CLI session."));',
  'this.waiting.reject(new Error("OLT closed the CLI session. Response tail: " + this.output.slice(-1800)));'
);
source = source.replace(
  'reject(new Error("Timed out waiting for the OLT command prompt."));',
  'reject(new Error("Timed out waiting for the OLT command prompt. Response tail: " + this.output.slice(-1800)));'
);
source = source.replace(
  '"The OLT connected, but its read-only PON response could not be verified."',
  '"The OLT connected, but its read-only PON response could not be verified. Cause: " + String(error?.message ?? error)'
);
const { readOntFromOlt } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const targets = [
  { customerId:5518,managementIp:'192.168.1.3',frameNumber:0,slotNumber:2,ponPortNumber:2,ontId:28 },
  { customerId:11095,managementIp:'192.168.1.5',frameNumber:0,slotNumber:3,ponPortNumber:2,ontId:0 },
  { customerId:14455,managementIp:'192.168.1.5',frameNumber:0,slotNumber:3,ponPortNumber:3,ontId:5 },
  { customerId:15010,managementIp:'192.168.1.87',frameNumber:0,slotNumber:3,ponPortNumber:1,ontId:15 },
];
for (const target of targets) {
  if (process.argv[2] && Number(process.argv[2]) !== target.customerId) continue;
  console.log(JSON.stringify({event:'reading',customerId:target.customerId,at:new Date().toISOString()}));
  try {
    console.log(JSON.stringify({customerId:target.customerId,result:await readOntFromOlt(target)}));
  } catch (error) {
    console.log(JSON.stringify({customerId:target.customerId,error:error.message}));
  }
}
