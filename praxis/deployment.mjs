import { createDemoIntegration } from './demo.mjs';
import { adminBootstrap } from './admin-bootstrap.mjs';
import { createStackIntegration } from './stack.mjs';
import { localCompose } from './local-compose.mjs';
import { createManagedService } from './managed-service.mjs';
export function createDeploymentIntegration() { return {
  demo: createDemoIntegration(),
  adminBootstrap,
  stack: createStackIntegration(),
  localCompose,
  managedService: createManagedService,
  managedServices: ['reminder'],
  allowSourceData: 'data',
  "dataId": "reminder",
  "volumes": [
    "reminder"
  ],
  "adapterPort": 4322,
  "runtime": {
    "REMINDER_MANAGED": "1",
    "REMINDER_BUSINESS_KEY_FILE": "/config/key",
    "REMINDER_BUSINESS_SPACES_FILE": "/config/spaces.json",
    "REMINDER_BUSINESS_UI_URL": "${origin}/business/reminder/"
  },
  "spaces": {
    "spaces": {
      "${spaceId}": "/data/reminder/checklist.json"
    }
  },
  "businessBindings": {
    "spacesFile": "/app-config/reminder/spaces.json"
  },
  "initialFiles": [],
  "native": {
    "dockerfile": "Dockerfile.praxis",
    "command": [
      "node",
      "src/server.js"
    ]
  },
  writerPorts: [4322]
}; }
