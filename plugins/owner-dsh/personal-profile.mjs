import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPersonalAccess } from './personal-access.mjs';

export function personalAccessForProfile(bridgeDir, profile, readProfileDocument) {
  return createPersonalAccess({
    bridgeDir,
    loadConfig: () => JSON.parse(readFileSync(join(bridgeDir, 'qq.json'), 'utf8')),
    readDocuments: () => ({
      skills: readProfileDocument(profile, 'role-skills'),
      people: readProfileDocument(profile, 'people'),
      state: readProfileDocument(profile, 'role-skills-state'),
    }),
  });
}
