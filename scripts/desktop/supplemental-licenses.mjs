/** Exact upstream notices missing from dependency tarballs, with pinned provenance. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function loadSupplementalNotices(
  packages,
  { root = path.join(import.meta.dirname, 'legal') } = {},
) {
  if (fs.lstatSync(root).isSymbolicLink())
    throw new Error('Supplemental notice root must not be linked.');
  const read = (name) => {
    if (
      typeof name !== 'string' ||
      name.split('/').some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === '..')
    )
      throw new Error('Invalid supplemental notice filename.');
    let file = root;
    for (const part of name.split('/')) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink())
        throw new Error('Supplemental notices must be regular files without linked ancestors.');
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error('Supplemental notices must be regular files under 1 MiB.');
    return fs.readFileSync(file);
  };
  const provenance = JSON.parse(read('provenance.json'));
  if (provenance.schemaVersion !== 1 || !Array.isArray(provenance.documents))
    throw new Error('Invalid supplemental notice provenance.');
  const documents = [];
  const files = [];
  const seen = new Set();
  for (const document of provenance.documents) {
    const bytes = read(document.file);
    if (
      seen.has(document.file) ||
      !bytes.length ||
      sha256(bytes) !== document.sha256 ||
      !/^https:\/\//.test(document.sourceUrl) ||
      !Array.isArray(document.associations) ||
      !document.associations.length
    )
      throw new Error('Supplemental notice provenance or bytes do not match.');
    seen.add(document.file);
    for (const association of document.associations)
      if (typeof association.package !== 'string' || typeof association.version !== 'string')
        throw new Error('Supplemental notices require exact package-version associations.');
    const associations = document.associations.filter((association) =>
      packages.some(
        (pkg) => pkg.name === association.package && pkg.version === association.version,
      ),
    );
    if (!associations.length) continue;
    const destination = `licenses/upstream/${document.file}`;
    documents.push({ ...document, associations, path: destination });
    files.push({ destination, bytes });
  }
  for (const pkg of packages.filter((item) => item.name === '@next/env'))
    for (const component of ['dotenv', 'dotenv-expand'])
      if (
        !documents.some((doc) =>
          doc.associations.some(
            (a) =>
              a.package === pkg.name &&
              a.version === pkg.version &&
              a.component === component &&
              a.componentVersion === { dotenv: '16.3.1', 'dotenv-expand': '10.0.0' }[component],
          ),
        )
      )
        throw new Error(
          `Missing exact-version supplemental notice for ${pkg.name} ${pkg.version}: ${component}.`,
        );
  return { documents, files };
}
