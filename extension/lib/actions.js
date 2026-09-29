// Validation of AI-proposed (or locally parsed) browser actions against an explicit allowlist.
// Nothing the AI returns is executed unless it passes validateAction(), and every action that
// closes tabs is shown to the user on a confirmation screen before it runs.
// Email sending and form submission are deliberately NOT in this list: those only happen from
// dedicated screens where the user reviews and confirms the exact content.

export const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const MAX_TABS_PER_ACTION = 200;

const SCHEMAS = {
  none: { fields: { reason: 'string?' } },
  search_tabs: { fields: { query: 'string' } },
  focus_tab: { fields: { tabId: 'tabId' } },
  group_tabs: { fields: { tabIds: 'tabIds', title: 'string?', color: 'color?' } },
  ungroup_tabs: { fields: { tabIds: 'tabIds' } },
  close_tabs: { fields: { tabIds: 'tabIds' }, closes: true },
  close_duplicate_tabs: { fields: {}, closes: true },
  save_tabs: { fields: { tabIds: 'tabIds', name: 'string?', close: 'boolean?' } },
  reopen_saved_group: { fields: { groupId: 'string' } },
};

export const ALLOWED_ACTIONS = Object.freeze(Object.keys(SCHEMAS));

function cleanString(v, max) {
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {object} action   proposed action, e.g. {type:'close_tabs', tabIds:[1,2]}
 * @param {object} ctx      { tabs: chrome.tabs.Tab[], savedGroups: [{id}], explicitTabIds: number[] }
 *                          explicitTabIds = tabs the user personally ticked; only these may include pinned tabs.
 * @returns {{ok:boolean, action?:object, errors:string[], warnings:string[], requiresConfirmation:boolean}}
 */
export function validateAction(action, ctx = {}) {
  const errors = [];
  const warnings = [];
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, errors: ['No action was proposed.'], warnings, requiresConfirmation: false };
  }
  const type = String(action.type || '');
  const schema = Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type] : null;
  if (!schema) {
    return { ok: false, errors: [`"${cleanString(type, 40) || 'unknown'}" is not an allowed action. Satchel can only search, focus, group, ungroup, save, reopen, or close tabs.`], warnings, requiresConfirmation: false };
  }
  const tabs = ctx.tabs || [];
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const explicit = new Set(ctx.explicitTabIds || []);
  const out = { type };

  for (const key of Object.keys(action)) {
    if (key !== 'type' && !Object.hasOwn(schema.fields, key)) warnings.push(`Ignored unexpected field "${cleanString(key, 30)}".`);
  }

  for (const [field, kind] of Object.entries(schema.fields)) {
    const optional = kind.endsWith('?');
    const base = optional ? kind.slice(0, -1) : kind;
    const value = action[field];
    if (value === undefined || value === null || value === '') {
      if (!optional) errors.push(`Missing "${field}".`);
      continue;
    }
    if (base === 'string') {
      if (typeof value !== 'string') { errors.push(`"${field}" must be text.`); continue; }
      out[field] = cleanString(value, field === 'query' ? 200 : 80);
    } else if (base === 'boolean') {
      if (typeof value !== 'boolean') { errors.push(`"${field}" must be true or false.`); continue; }
      out[field] = value;
    } else if (base === 'color') {
      if (!TAB_GROUP_COLORS.includes(value)) { warnings.push(`Unknown color "${cleanString(value, 20)}"; using blue.`); out[field] = 'blue'; } else out[field] = value;
    } else if (base === 'tabId') {
      const id = Number(value);
      if (!Number.isInteger(id) || !byId.has(id)) { errors.push('That tab no longer exists.'); continue; }
      out[field] = id;
    } else if (base === 'tabIds') {
      if (!Array.isArray(value)) { errors.push(`"${field}" must be a list of tabs.`); continue; }
      const ids = [...new Set(value.map(Number))];
      const valid = ids.filter((id) => Number.isInteger(id) && byId.has(id));
      if (valid.length < ids.length) warnings.push(`${ids.length - valid.length} tab(s) no longer exist and were skipped.`);
      let finalIds = valid;
      if (schema.closes || field === 'tabIds') {
        const pinnedNotExplicit = valid.filter((id) => byId.get(id).pinned && !explicit.has(id));
        if (pinnedNotExplicit.length && (schema.closes || (type === 'save_tabs' && action.close))) {
          finalIds = valid.filter((id) => !pinnedNotExplicit.includes(id));
          warnings.push(`${pinnedNotExplicit.length} pinned tab(s) were left out. Tick them yourself if you really want them included.`);
        }
      }
      if (finalIds.length > MAX_TABS_PER_ACTION) { errors.push(`Too many tabs (max ${MAX_TABS_PER_ACTION}).`); continue; }
      if (!finalIds.length) { errors.push('No valid tabs were selected.'); continue; }
      out[field] = finalIds;
    }
  }

  if (type === 'reopen_saved_group' && out.groupId && !(ctx.savedGroups || []).some((g) => g.id === out.groupId)) {
    errors.push('That saved group was not found.');
  }
  if (type === 'save_tabs' && out.close === undefined) out.close = false;

  const closesTabs = schema.closes || (type === 'save_tabs' && out.close === true);
  return {
    ok: errors.length === 0,
    action: errors.length === 0 ? out : undefined,
    errors,
    warnings,
    closesTabs,
    // Any action that closes tabs is always confirmed (the requirement is at least "multiple tabs").
    requiresConfirmation: closesTabs,
  };
}
