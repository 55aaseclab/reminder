import { projectInventory } from './inventory.mjs';
function validateReminder(document) { if(!document||document.version!==2)throw Error('Reminder schema version 2 is required');for(const key of ['recurring','plans','pool','history'])if(!Array.isArray(document[key])||document[key].some(item=>!item||typeof item.id!=='string'||typeof item.text!=='string'||!Array.isArray(item.tags)))throw Error('Invalid Reminder document'); }
export function createStorageIntegration() { return {
  inventory: { project: projectInventory, mapping: { field: 'spacesFile', input: 'reminderSpaces' } },
  "rootId": "reminder",
  "paths": {
    "reminder": ""
  },
  "sources": [
    {
      "kind": "sqlite",

      "spaceMap": "reminder",
      "basePath": "reminder",
      "filename": "reminder.db",
      "primaryTarget": "reminder.db",
      "registerDefault": true,
      "nativeSource": "data/reminder.db"
    }
  ],
  "omissions": [],
  validators: {"reminder-v2": validateReminder},
  relocation: {
  "spaceMap": {
    "input": "reminderMapping",
  "fileField": "spacesFile",
    "assertionInput": "reminderSpaces",
    "path": "reminder",
    "mode": "basename",
    "filename": "reminder.db"
  }
},
  activation: { skipService: true, stackFlag: "--without-reminder", storageConfigFlag: "dockerWithoutReminder", requireManaged: true, mappingFileField: "spacesFile", sourceMapKey: "reminder" },
  recovery: { configFields: ['spacesFile'], omissionPrefix: 'business/reminder/', async collect(ctx) {
    const mapping = await ctx.readConfiguration('spacesFile');
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).some(key => key !== 'spaces') || !mapping.spaces || typeof mapping.spaces !== 'object' || Array.isArray(mapping.spaces) || !Object.keys(mapping.spaces).length) ctx.fail('INVALID_CONFIG', 'Reminder space configuration requires an explicit spaces mapping');
    const active = await ctx.activeSpaces(), mapped = new Set();
    for (const [spaceId, file] of Object.entries(mapping.spaces)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(spaceId)) ctx.fail('INVALID_CONFIG', 'Reminder space identifier is invalid');
      const source = await ctx.inspect(file);
      const database=/\.(?:db|sqlite3?)$/i.test(source.path); if(mapped.has(source.path)){if(database)continue;ctx.fail('INVALID_BACKUP_SOURCE','JSON spaces must have distinct files');}
      mapped.add(source.path); const opaqueId = ctx.opaqueSpaceId(spaceId);
      if (!await ctx.register({ kind: database?'sqlite':'json', source: source.path, target: database?'reminder.db':`spaces/${opaqueId}.json`, ...(!database?{schema:'reminder-v2'}:{}) }, { optional: !Object.entries(mapping.spaces).some(([id,path])=>path===file&&active.has(id)) })) ctx.omit(opaqueId + ':uninitialized');
    }
  } }
}; }
