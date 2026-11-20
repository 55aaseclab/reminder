export function createWebIntegration() {
  return {
    "slug": "reminder",
    "policy": "grant",
    "kind": "proxy",
    "corePages": [{"path": "/business/reminder/", "file": "praxis/legacy-ui/reminder.html"}],
    "coreAssets": [{"path": "/reminder.js", "file": "praxis/legacy-ui/reminder.js", "type": "application/javascript"}, {"path": "/reminder-view.js", "file": "praxis/legacy-ui/reminder-view.js", "type": "application/javascript"}, {"path": "/reminder-view-model.js", "file": "praxis/legacy-ui/reminder-view-model.js", "type": "application/javascript"}, {"path": "/reminder-view.css", "file": "praxis/legacy-ui/reminder-view.css", "type": "text/css"}],
    "legacyPaths": ["/business/reminder/"],
    "nativePort": 4322
  };
}
