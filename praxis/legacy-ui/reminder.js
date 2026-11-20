import { t } from './i18n.js';
import { createAppTransport, populateContexts } from './app-transport.js';
import { createReminderView } from './reminder-view.js';

const main = document.querySelector('#main'), select = document.querySelector('#space');
let epoch = 0, dirty = false;
const link = new URLSearchParams(location.search);
let linkedItem = link.get('item');
const contextLabels = () => ({ types: { personal: t('Personal reminders', '个人提醒'), family: t('Family reminders', '家庭提醒'), company: t('Team reminders', '团队提醒') }, fallback: t('Reminder lists', '提醒列表') });
const client = createAppTransport('reminder', { onChange: () => void load(false), onStatus: text => view.setStatus(text), onRevoked: () => { epoch++; dirty = false; populateContexts([], contextLabels()); view.clear(t("Access changed. Reopen Reminder.", '访问权限已变化，请重新打开提醒事项。')); } });
const view = createReminderView({ main, navigation: document.querySelector('#navigation'), invoke: client.invoke, reload: () => client.context ? load(false) : initialize(), onDirtyChange: value => { dirty = value; } });
async function load(reconnect = true) {
  if (!client.context) return;
  const current = ++epoch; main.setAttribute('aria-busy', 'true');
  try { if (reconnect) client.subscribe(); const result = await client.invoke('list'); if (current === epoch) { view.render(result.items); if (linkedItem) { view.focusResource(linkedItem); linkedItem = null; } } }
  catch (error) { if (current === epoch) { if ([401, 403].includes(error.status)) { client.disconnect(); populateContexts([], contextLabels()); } view.showError(error); } }
  finally { if (current === epoch) main.setAttribute('aria-busy', 'false'); }
}
let initializing = false;
async function initialize() {
  if (initializing) return;
  initializing = true; main.setAttribute('aria-busy', 'true');
  try {
    const result = await client.initialize(); populateContexts(result.contexts, contextLabels());
    if (!result.authorized) return view.clear(t("No content to display.", '暂无可显示的内容。'));
    if (!result.contexts.length) return view.clear(t("No accessible reminder lists.", '目前没有可访问的提醒列表。'));
    if (linkedItem && link.get('space')) {
      if (!result.contexts.some(ctx => ctx.id === link.get('space'))) return view.clear(document.documentElement.lang.startsWith('zh') ? '此事项不可用。' : 'This item is unavailable.');
      client.selectContext(link.get('space')); select.value = link.get('space');
    }
    await load();
  } catch (error) { view.showError(error); }
  finally { initializing = false; main.setAttribute('aria-busy', 'false'); }
}
select.addEventListener('change', () => {
  if (dirty) { select.value = client.context?.id || ''; document.querySelector('#notice').textContent = t("Saving changes. Switch after the save finishes.", '操作正在保存，请稍后切换。'); return; }
  epoch++; view.resetScope(); client.selectContext(select.value); void load();
});
addEventListener('offline', () => view.setStatus(t("Offline", '离线')));
addEventListener('online', () => { if (!dirty && client.context) void load(); });
addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
void initialize();
