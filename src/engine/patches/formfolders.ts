/**
 * erablue_resort (EN branch) form-change image folders, patch `erablue-form-folders`.
 * The game looks portraits up in `resources/<NO><key>`; for Vikala (6) and Cagliostro (25) the form-change scripts write Japanese keys
 * (`6ビカラ`, `6ビカラ（陰）`, `25カリオストロ`, `25大人カリオストロ`), and `FIX_RESOURCES_FOLDER` only falls back to the English CALLNAME
 * (which is the same for both Cagliostro forms). Folders with English names therefore cannot show the second form.
 * This patch leaves the game's logic alone and only adds names to the file list: a pack folder with the short English name below is also
 * visible under the name the game asks for. A real folder with the Japanese name is never replaced.
 *   6Vikala         -> 6ビカラ            (yang, ears on)
 *   6VikalaY        -> 6ビカラ（陰）, 6Vikala (Yin)   (yin, ears off)
 *   25Cagliostro    -> 25カリオストロ     (normal)
 *   25CagliostroA   -> 25大人カリオストロ   (adult)
 */
export const FORM_FOLDER_ALIASES: readonly (readonly [string, readonly string[]])[] = [
  ['6Vikala', ['6ビカラ']],
  ['6VikalaY', ['6ビカラ（陰）', '6Vikala (Yin)']],
  ['25Cagliostro', ['25カリオストロ']],
  ['25CagliostroA', ['25大人カリオストロ']],
];

/** adds the alias paths to `images` (same bytes, no copy); returns the folders that were aliased as "from -> to" */
export function addFormFolderAliases<T>(images: Record<string, T>): string[] {
  const top = new Map<string, string[]>(); // lower-cased top folder under resources/ -> its keys
  for (const k of Object.keys(images)) {
    const m = /^resources\/([^/]+)\//i.exec(k.replace(/\\/g, '/'));
    if (!m) continue;
    const f = m[1].normalize('NFC').toLowerCase();
    let l = top.get(f);
    if (!l) top.set(f, (l = []));
    l.push(k);
  }
  const done: string[] = [];
  for (const [src, aliases] of FORM_FOLDER_ALIASES) {
    const keys = top.get(src.toLowerCase());
    if (!keys) continue;
    for (const to of aliases) {
      if (top.has(to.normalize('NFC').toLowerCase())) continue; // the real folder wins
      for (const k of keys) images[k.replace(/^resources[\\/][^\\/]+/i, 'resources/' + to)] = images[k];
      done.push(`${src} -> ${to}`);
    }
  }
  return done;
}
