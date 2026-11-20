import { parseFragment } from 'parse5';
function title(markup) {
  if (!/[<&]/.test(markup)) return markup;
  const visit = node => ['script', 'style'].includes(node.tagName) ? '' : node.tagName === 'br' ? ' ' : node.value ?? (node.childNodes || []).map(visit).join('');
  return visit(parseFragment(markup)).trim();
}
export function createBusinessHooks() {
  return {
    assertionFields: ['sourceReadGranted'], assertionRules: { sourceReadGranted: { kind: 'source-read' } },
    sourceAuthorizations: request => request.operation === 'record' ? [{ appId: 'reminder', spaceId: request.spaceId, resourceId: request.sourceResourceId, action: 'read' }] : [],
    prepareInvocation: (request, ctx) => request.operation === 'record' ? { assertion: { sourceReadGranted: ctx.sourceReadGranted } } : {},
    projectResult(request, result, ctx) {
      if (request.operation !== 'list' || !Array.isArray(result.items)) return result;
      return { ...result, items: result.items.map(entry => ({ ...entry, allowedActions: ['read', ...['update', 'complete'].filter(action => typeof entry.resourceId === 'string' && !(action === 'complete' && entry.collection === 'recurring') && ctx.hasAction(action, entry.resourceId))] })) };
    },
    workbench: { async agenda(ctx) {
      const { spaces, partial } = await ctx.items('list'), items = [];
      for (const space of spaces) for (const { resourceId, collection, item } of space.items) {
        if (!item || item.done || !['plans', 'pool'].includes(collection) || typeof item.text !== 'string') continue;
        const date = typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?$/.test(item.date) ? item.date : null;
        if (date || item.flagged) items.push({ resourceId, spaceId: space.spaceId, title: title(item.text), date, flagged: item.flagged === true });
      }
      return { items, partial };
    } },
  };
}
