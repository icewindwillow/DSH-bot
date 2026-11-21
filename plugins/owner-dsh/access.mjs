const openid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const alias = value => typeof value === 'string' && /^[\p{L}\p{N}_-]{1,32}$/u.test(value);

export function createAccess({ owner, ownerGroupOpenids = {}, members = [] } = {}) {
  if (!openid(owner)) throw new Error('Expected a trusted owner C2C OpenID');
  const byName = new Map();
  const byDm = new Map();
  const byPrincipal = new Map();
  const byGroup = new Map();
  for (const entry of members) {
    const principal = entry.principal ?? entry.dmOpenid;
    if (!alias(entry.name) || entry.name === 'owner' || byName.has(entry.name) ||
        !openid(principal) || principal === owner || byPrincipal.has(principal) ||
        (entry.dmOpenid !== undefined && (!openid(entry.dmOpenid) || entry.dmOpenid === owner || byDm.has(entry.dmOpenid)))) {
      throw new Error('Invalid or duplicate DSH workspace member');
    }
    const member = { principal, workspace: entry.name, dmOpenid: entry.dmOpenid, owner: false };
    byName.set(entry.name, member);
    byPrincipal.set(principal, member);
    if (entry.dmOpenid) byDm.set(entry.dmOpenid, member);
    for (const [group, sender] of Object.entries(entry.groups ?? {})) {
      const key = `${group}:${sender}`;
      if (!openid(group) || !openid(sender) || sender === owner ||
          ownerGroupOpenids[group] === sender || byGroup.has(key)) throw new Error('Invalid or duplicate group identity');
      byGroup.set(key, member);
    }
  }
  for (const [group, sender] of Object.entries(ownerGroupOpenids)) {
    if (!openid(group) || !openid(sender)) throw new Error('Invalid owner group identity');
  }
  const ownerIdentity = { principal: owner, workspace: 'owner', dmOpenid: owner, owner: true };
  return {
    identify({ scope, sender, group }) {
      if (!openid(sender)) return;
      if (scope === 'c2c' && !group) return sender === owner ? ownerIdentity : byDm.get(sender);
      if (scope !== 'group' || !openid(group)) return;
      if (sender === owner || sender === ownerGroupOpenids[group]) return ownerIdentity;
      return byGroup.get(`${group}:${sender}`);
    },
    recipients() {
      return [ownerIdentity, ...[...byPrincipal.values()].filter(member => member.dmOpenid)];
    },
    workspace(identity, requested) {
      if (!requested || requested === identity.workspace) return identity;
      if (identity.owner) return byName.get(requested);
    },
  };
}

export function identityHeaders({ scope, sender, group }) {
  return { 'x-qq-scope': scope, 'x-qq-sender': sender, ...(group && { 'x-qq-group': group }) };
}

export function wireIdentity(headers) {
  return { scope: headers['x-qq-scope'], sender: headers['x-qq-sender'], group: headers['x-qq-group'] };
}
