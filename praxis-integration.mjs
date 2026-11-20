import { createBusinessHooks } from './praxis/business-hooks.mjs';
import { createWebIntegration } from './praxis/web.mjs';
import { createStorageIntegration } from './praxis/storage.mjs';
import { createDeploymentIntegration } from './praxis/deployment.mjs';

export function createIntegration({ z }) {
const businessError=(status,code)=>Object.assign(new Error(code),{status,code});
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const itemFields = {
  text: z.string().min(1).max(20000), date: z.string().max(19).optional(), tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  notes: z.string().max(20000).optional(), location: z.string().max(20000).optional(), estHours: z.number().positive().max(100000).optional(),
  actualHours: z.number().min(0).max(100000).optional(), flagged: z.boolean().optional(),
};
const common = { spaceId: id }, mutation = { ...common, idempotencyKey: id };
const target = { ...mutation, resourceId: id, expectedRevision: z.string().min(1).max(200) };
function planningInput(schema, args) {
  const { spaceId: ignoredSpace, resourceId: ignoredResource, expectedRevision: ignoredRevision, idempotencyKey: ignoredKey, ...input } = args;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw businessError(400, 'INVALID_INPUT');
  return parsed.data;
}

const operationActions={"list":"read","stats":"read","events":"read","add":"create","record":"create","update":"update","complete":"complete","delete":"delete"};
const operations=Object.fromEntries(Object.entries(operationActions).map(([name,action])=>[name,{action,mutation:action!=='read'}]));
const observedCapabilities={"list":"read","stats":"stats","events":"read","add":"create","record":"create","update":"update","complete":"complete","delete":"delete"};
for(const [name,definition]of Object.entries(operations))definition.capability=observedCapabilities[name];
function validateInvocation(request) {
const {appId,operation,spaceId,resourceId}=request;const action=operationActions[operation];
if(operation==='record'&&(!identifier(request.sourceResourceId)||resourceId!==undefined))throw businessError(400,'SOURCE_RESOURCE_REQUIRED');
if(operation!=='record'&&request.sourceResourceId!==undefined)throw businessError(400,'INVALID_REQUEST');
if(['update','complete','delete'].includes(operation)&&!resourceId)throw businessError(400,'RESOURCE_REQUIRED');

}
return {schemaVersion:1,appId:"reminder",web:createWebIntegration(),storage:createStorageIntegration(),deployment:createDeploymentIntegration(),business:{adapterId:"reminder",actions:["read","create","update","complete","delete"],scopes:{"reminder:read":["read"],"reminder:write":["create","update","complete","delete"]},targetedCreate:true,operations,tools:[
{ name: 'reminder_list', appId: 'reminder', operation: 'list', action: 'read', description: 'Read reminders visible in one authorized space. Resource IDs are stable; legacy item IDs may repeat.', schema: z.object(common).strict() },
{ name: 'reminder_add', appId: 'reminder', operation: 'add', action: 'create', description: 'Create a reminder using a stable idempotency key. For a finite resource grant, supply the exact preauthorized future resourceId; the service rejects an existing or ungranted ID. Omitting resourceId requires whole-space creation permission. Item identity and completion fields remain server-owned. Data is stored by Reminder.', schema: z.object({ ...mutation, resourceId: z.string().regex(/^r_[A-Za-z0-9_-]{16,64}$/).optional(), item: z.object(itemFields).strict(), collection: z.enum(['recurring', 'plans', 'pool']).optional() }).strict(), input: args => ({ item: args.item, ...(args.collection ? { collection: args.collection } : {}) }) },
{ name: 'reminder_update', appId: 'reminder', operation: 'update', action: 'update', description: 'Update allowed reminder fields at the expected resource revision. Read the new revision before retrying a conflict.', schema: z.object({ ...target, patch: z.object(itemFields).partial().strict() }).strict(), input: args => args.patch },
{ name: 'reminder_complete', appId: 'reminder', operation: 'complete', action: 'complete', description: 'Complete or reopen a reminder at its expected revision, optionally recording actual hours.', schema: z.object({ ...target, done: z.boolean().optional(), actualHours: z.number().min(0).max(100000).optional(), completedAt: z.string().max(19).optional() }).strict(), input: args => Object.fromEntries(['done', 'actualHours', 'completedAt'].filter(k => args[k] !== undefined).map(k => [k, args[k]])) },
{ name: 'reminder_delete', appId: 'reminder', operation: 'delete', action: 'delete', description: 'Delete only the specified authorized reminder at its expected revision. No bulk cleanup.', schema: z.object(target).strict() },
{ name: 'reminder_stats', appId: 'reminder', operation: 'stats', action: 'read', description: 'Read time analysis for authorized reminders only.', schema: z.object({ ...common, period: z.enum(['week', 'month']).optional(), anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(), input: args => Object.fromEntries(['period', 'anchor'].filter(k => args[k] !== undefined).map(k => [k, args[k]])) },
{ name: 'reminder_record', appId: 'reminder', operation: 'record', action: 'create', sourceRead: true, description: 'Record execution of a recurring template without completing the template. Requires create permission and read access to the source template; the saved execution feeds time statistics.', schema: z.object({ ...mutation, sourceResourceId: id, expectedRevision: z.string().min(1).max(200), actualHours: z.number().min(0).max(100000), completedAt: z.string().max(19).optional() }).strict(), input: args => Object.fromEntries(['actualHours', 'completedAt'].filter(k => args[k] !== undefined).map(k => [k, args[k]])) }
],skill:{name:"mcp-reminder",path:"skills/mcp-reminder/SKILL.md"},instructions:[],validateInvocation,...createBusinessHooks({}),schemas:{},events:{operation:'events'}}};
}
