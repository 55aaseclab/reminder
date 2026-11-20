import { dirname, resolve } from 'node:path';
export async function createManagedService({ app: reminder, config, corePort: port, uid, gid, workspace, controlDirectory, stateDirectories, appDirectories, readOnlyFiles, privatePath, readPrivateJson, distinctDirectories, mount, overlaps, isWithin, fail, build }) {
  const services = {}, ports = [];
  if (reminder?.managed !== undefined && typeof reminder.managed !== 'boolean') fail('INVALID_MANAGED_SETTING', 'Managed Reminder must be explicitly true or false.');
  if (reminder?.managed === true) {
    const endpoint = new URL(reminder.url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.port !== '4322' || endpoint.pathname !== '/api/business' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) fail('INVALID_MANAGED_ENDPOINT', 'Managed Reminder requires its fixed loopback port4322 endpoint.');
    await privatePath(reminder.spacesFile);
    const mapping = await readPrivateJson(reminder.spacesFile);
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).some(key => key !== 'spaces') || !mapping.spaces || typeof mapping.spaces !== 'object' || Array.isArray(mapping.spaces) || Object.keys(mapping.spaces).sort().join('\0') !== [...reminder.spaces].sort().join('\0')) fail('INVALID_SPACE_MAPPING', 'Reminder mapping must exactly match its configured business spaces.');
    const dataFiles = Object.values(mapping.spaces);
    if (new Set(dataFiles).size !== dataFiles.length || dataFiles.some(file => typeof file !== 'string' || !file.endsWith('.json'))) fail('INVALID_SPACE_MAPPING', 'Reminder spaces require distinct JSON data files.');
    for (const file of dataFiles) await privatePath(file, { allowMissing: true, data: true, maxSize: Infinity });
    const dataDirectories = distinctDirectories(dataFiles.map(file => dirname(file)));
    appDirectories.push(...dataDirectories);
    for (const directory of dataDirectories) {
      await privatePath(directory, { directory: true, data: true });
      if (stateDirectories.some(state => overlaps(state, directory)) || readOnlyFiles.concat(reminder.spacesFile).some(file => isWithin(directory, file)) || isWithin(directory, controlDirectory)) fail('OVERLAPPING_DATA_MOUNT', 'Reminder data must stay separate from identity state, secrets and Docker controls.');
    }
    services.reminder = {
      image: 'praxis-business/reminder:local',
      build,
      command: ['node', 'src/server.js', '--host', config.webGateway?.enabled === true ? '127.0.0.1' : '0.0.0.0', '--port', '4322'],
      network_mode: 'host', init: true, user: `${uid}:${gid}`, read_only: true, restart: 'unless-stopped',
      cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], tmpfs: ['/tmp:rw,nosuid,nodev,size=64m,mode=1777'], stop_grace_period: '30s',
      environment: { REMINDER_MANAGED: '1', REMINDER_BUSINESS_KEY_FILE: reminder.keyFile, REMINDER_BUSINESS_SPACES_FILE: reminder.spacesFile, REMINDER_BUSINESS_UI_URL: `${config.issuer}/business/reminder/` },
      healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4322/health').then(async r=>{const h=await r.json();if(!r.ok||h.managed!==true)process.exit(1)}).catch(()=>process.exit(1))"], interval: '10s', timeout: '5s', retries: 3, start_period: '10s' },
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      volumes: [...dataDirectories.map(directory => mount(directory)), mount(reminder.keyFile, true), mount(reminder.spacesFile, true)],
    };
    ports.push(4322);
  }
  return { services, ports };
}
