import { join } from 'node:path';
export function projectInventory({id,config,working,workspaceId,storage,reminderSpaces,slidesSpaces,polaris,financeMounts,financeProjectName,intelligenceRuntime,locations,add,file,source,safePath,paths,object}) {

      for (const path of new Set(paths(reminderSpaces))) file('业务空间任务', /\.(?:db|sqlite3?)$/i.test(path)?'sqlite':'json', path);
}
