import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const isWithin = (parent, child) => { const path = relative(resolve(parent), resolve(child)); return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)); };
const bind = (source, target, read_only) => ({ type: 'bind', source, target, read_only, bind: { create_host_path: false } });
export function createStackIntegration() { return {
services: [{ name: 'reminder', port: 4322, excludeWhen: 'withoutReminder' }],
cliFlags: [{ flag: '--without-reminder', setting: 'withoutReminder' }],
resolveSources(ctx) { const withoutReminder = ctx.options.withoutReminder ?? (ctx.config.dockerWithoutReminder === true); if (typeof withoutReminder !== 'boolean') throw new Error('Reminder exclusion must be explicit.'); const path = ctx.registeredMode ? (ctx.config.appSources?.some(source=>source.id==='reminder'&&source.target==='reminder.db')?ctx.registered('reminder','reminder.db','sqlite'):ctx.registered('reminder','checklist.json','json')) : join(ctx.appsRoot, 'reminder/reminder.db'); return { settings: { withoutReminder }, sources: [{ key: 'reminder', path, order: 1 }], data: [{ path: dirname(path), kind: 'directory', writable: true }, { path, kind: 'file', writable: true, nonempty: true }] }; },
environment: ({ settings }) => ({ PRAXIS_REMINDER_DATA_DIR: dirname(settings.sourceMap.reminder) }),
checkRunning({ settings, status }) { if (settings.withoutReminder && status.services.some(service => service.name === 'reminder' && service.state === 'running')) throw new Error('A duplicate Reminder is still running in the base project. Stop it before using the business profile.'); }
}; }
