import { join } from 'node:path';

// The caller provides only fresh, isolated demo paths and a loopback port.
export function createDemoIntegration() {
  return {
    supported: true, module: 'praxis/demo.mjs',
    plan({ dataDir, port }) {
      return {
        steps: [{ command: 'node', args: ['src/cli.js', 'import', 'data/checklist.example.json'], environment: { REMINDER_DATA: join(dataDir, 'checklist.json') } }],
        server: { args: ['src/server.js'], environment: { REMINDER_DATA: join(dataDir, 'checklist.json') } },
      };
    },
  };
}
