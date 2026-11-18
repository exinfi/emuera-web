/** Resource-pack manager UI: the pack list, order, enable/disable, sizes; storage and scanning are the packs.ts (host/web). */
import { addPack, listPacks, movePack, parsePackInfo, removePack, setEnabled, type PackMeta } from '../host/web/packs';

const $ = (id: string) => document.getElementById(id)!;
export const fmtSize = (n: number) =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

export interface PacksDeps {
  say(msg: string): void;
  problem(msg: string): void;
  canApply(): boolean;
  apply(): void;
}

export function createPacks(d: PacksDeps) {
  const open = new Set<string>(); // packs whose file list is expanded
  async function refresh() {
    const list = $('packlist');
    let packs: PackMeta[];
    try {
      packs = await listPacks();
    } catch {
      list.textContent = 'Resource packs are unavailable (browser storage is blocked).';
      list.className = 'small';
      ($('padd') as HTMLInputElement).disabled = true;
      return;
    }
    list.textContent = '';
    list.className = ''; // cleared only after the data is in hand, so the list never flashes empty
    ($('papply') as HTMLButtonElement).disabled = !d.canApply();
    if (!packs.length) {
      list.textContent = 'No packs.';
      list.className = 'small';
      return;
    }
    const total = packs.reduce((s, p) => s + p.size, 0),
      on = packs.filter((p) => p.enabled).reduce((s, p) => s + p.size, 0);
    const sum = document.createElement('div');
    sum.className = 'small';
    sum.textContent = `${packs.length} pack(s), ${fmtSize(total)} stored (${fmtSize(on)} enabled).`;
    list.appendChild(sum);
    packs.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'pack' + (p.enabled ? '' : ' off');
      const head = document.createElement('div');
      head.className = 'phead';
      const nm = document.createElement('b');
      nm.textContent = `${i + 1}. ${p.name}`;
      const sz = document.createElement('span');
      sz.className = 'small';
      sz.textContent = ` ${fmtSize(p.size)}`;
      head.append(nm, sz);
      const tags = [
        p.scan.hasCode ? 'code (ERB)' : '',
        p.scan.hasData ? 'data (CSV)' : '',
        p.enabled ? '' : 'disabled',
      ].filter(Boolean);
      const info = document.createElement('div');
      info.className = 'small';
      info.textContent = p.scan.summary + (tags.length ? '  [' + tags.join(', ') + ']' : '');
      const row = document.createElement('div');
      row.className = 'row';
      const btn = (label: string, title: string, on_: () => Promise<void>, dis = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.disabled = dis;
        b.onclick = async () => {
          await on_();
          await refresh();
        };
        row.appendChild(b);
        return b;
      };
      btn('▲', 'Load earlier', () => movePack(p.id, -1), i === 0);
      btn('▼', 'Load later', () => movePack(p.id, 1), i === packs.length - 1);
      btn(p.enabled ? 'Disable' : 'Enable', 'Turn this pack off or on', () => setEnabled(p.id, !p.enabled));
      btn('Remove', 'Delete this pack from the browser', () => removePack(p.id));
      btn(open.has(p.id) ? 'Hide files' : 'Files', 'List what the pack contains', async () => {
        if (open.has(p.id)) open.delete(p.id);
        else open.add(p.id);
      });
      el.append(head, info, row);
      if (p.scan.note) {
        const n = document.createElement('div');
        n.className = 'small';
        n.textContent = p.scan.note;
        el.appendChild(n);
      }
      if (p.scan.info) {
        // the optional pack.txt, shown here only (text only, never loaded into a game)
        const pi = parsePackInfo(p.scan.info),
          meta = [pi.name, pi.author && 'by ' + pi.author, pi.version && 'v' + pi.version, pi.game && 'for ' + pi.game]
            .filter(Boolean)
            .join(' · ');
        const box = document.createElement('div');
        box.className = 'pinfo small';
        if (meta) {
          const m = document.createElement('span');
          m.className = 'pmeta';
          m.textContent = meta;
          box.appendChild(m);
        }
        if (pi.url) {
          const u = document.createElement('div');
          u.textContent = pi.url;
          box.appendChild(u);
        }
        if (pi.description) {
          const d = document.createElement('div');
          d.className = 'pdesc';
          d.textContent = pi.description;
          box.appendChild(d);
        }
        el.appendChild(box);
      }
      if (open.has(p.id)) {
        const f = document.createElement('div');
        f.className = 'pfiles small';
        const shown = p.scan.files.slice(0, 300);
        f.textContent =
          shown.map((x) => `${x.kind.padEnd(7)} ${x.path}`).join('\n') +
          (p.scan.files.length > shown.length ? `\n… ${p.scan.files.length - shown.length} more` : '');
        el.appendChild(f);
      }
      list.appendChild(el);
    });
  }
  /** add packs from files; a pack with the same name and size as one already stored is skipped (repeating "load bundled" must not duplicate) */
  async function addFiles(files: File[], skipSame = false) {
    let added = 0,
      skipped = 0;
    const have = skipSame ? await listPacks().catch(() => [] as PackMeta[]) : [];
    for (const f of files) {
      if (have.some((p) => p.name === f.name && p.size === f.size)) {
        skipped++;
        continue;
      }
      try {
        await addPack(f);
        added++;
      } catch (e) {
        d.problem(`PACK ADD FAILED: ${f.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    await refresh();
    return { added, skipped };
  }
  ($('padd') as HTMLInputElement).onchange = async (e) => {
    const el = e.target as HTMLInputElement,
      fs = Array.from(el.files ?? []);
    el.value = '';
    if (!fs.length) return;
    const r = await addFiles(fs);
    d.say(
      r.added
        ? `Added ${r.added} pack(s). They apply when a game is loaded${d.canApply() ? ' (use "Apply: reload game")' : ''}.`
        : 'No pack was added: see the debug log.',
    );
  };
  $('papply').onclick = () => d.apply();
  return { refresh, addFiles };
}
