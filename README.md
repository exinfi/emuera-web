# emuera-web

**[0]** https://exinfi.github.io/emuera-web/

## What is this?

emuera-web is a browser-based Emuera interpreter that aims to run era games on a computer or a phone. Once the page has loaded, it runs entirely on your local device and needs no network connection.

The interpreter is an independent browser port of Emuera. It is not an official Emuera release: it aims to run the same games in a faithful manner, but it is a separate program. It was not made by the authors of Emuera or its branches. Issues you run into may be caused by this implementation rather than by the game or by Emuera. Please do not contact the game authors, or of Emuera or its branches, about them.


emuera-web は、eraゲームをパソコンやスマートフォンで動作させることを目指した、ブラウザベースのEmueraインタープリターです。ページの読み込みが完了した後は、すべてお使いの端末上で動作し、ネットワーク接続は必要ありません。

本インタープリターは、Emueraの独立したブラウザ移植版です。Emueraの公式リリースではなく、同じゲームを忠実に動作させることを目指してはいますが、Emueraとは別のプログラムです。Emueraおよびその派生版の作者によって作られたものではありません。本実装が原因で発生する問題がある可能性がありますので、そのような問題について、ゲームの作者の方やEmuera（およびその派生版）の作者の方にお問い合わせになることはお控えください。

## How to Build

You need Node 22. Then:

```
npm install
npm run build:site
```

This writes `site/`, a site you can host on any static host, such as GitHub Pages. The player is a single file, `site/index.html`.

`npm run build:mobile` builds just that single-file player, to `dist-play/play.html`, without making `site/`.

To check your changes: `npm run typecheck` and `npm test`. Tests are grouped by area (`npm run test:engine`, `test:host`, `test:data`), and `npm run test:changed` runs only the areas touched by your changes. See `tests/README.md`.

## How to Use

### Quickstart
1. Open the page and press the menu button (the three bars) to show the control panel.
2. Under **Game**, press **Load game zip…** and pick your game's zip file. **You can also drop the zip on the page if your device supports it.**
    - Most supported files (game, memory card, resource packs, translation packs) can be easily dropped in, otherwise use the respective load button.
3. The game supports both mouse input on desktop and tap input on mobile devices.
    - The keyboard icon can be used to show/hide the text input box.
    - If on mobile, the **L / R / H** button at the top left sets what a tap does: left click, right click, or hover (a long press does the other click).
4. **Reload Game** starts the loaded game again from the beginning.

The default options work for most games. If a game keeps its files in an unusual folder layout, you may need to turn on the extra file check in **Options**.


1. ページを開き、メニューボタン（三本線のアイコン）を押してコントロールパネルを表示します。
2. **Game** の **Load game zip…** を押して、ゲームのzipファイルを選びます。zipファイルをページにドラッグ＆ドロップしても読み込めます。
3. デスクトップではマウス操作、モバイル端末ではタップ操作で遊べます。
    - キーボードのアイコンで、テキスト入力欄の表示／非表示を切り替えられます。
    - モバイルでは、左上の **L / R / H** ボタンでタップの動作（左クリック、右クリック、ホバー）を切り替えます（長押しでもう一方のクリックになります）。
4. **Reload Game** を押すと、読み込み済みのゲームを最初からやり直します。

ほとんどのゲームは、初期設定のままで動作します。ゲームのファイルが特殊なフォルダ構成になっている場合は、**Options** の追加のファイル確認（extra file check）を有効にする必要があるかもしれません。

### Saves

Saves are kept in your browser, in "memory cards" associated to their games. They stay on this device and in this browser only. Clearing your browser's site data, or switching browsers or devices, loses them.

Use **Export saves** (under **Memory card**) to download a backup zip, and **Import saves…** to restore one. Make a backup before you clear browser data.

> **Importing from native Emuera** emuera-web uses its own save format, so `.sav` files from the desktop Emuera are not read directly. There is a conversion for them (**Import sav folder zip…** and **Export sav folder zip**), but it is experimental. Keep your original `.sav` files, do not rely on a converted save alone, and expect that a conversion in either direction may not be exact.


セーブデータは、ゲームに紐づけられた「メモリーカード」としてブラウザ内に保存されます。1つのゲームに複数のカードを持つこともできます。保存先はこの端末のこのブラウザだけです。ブラウザのサイトデータを消去したり、別のブラウザや端末に切り替えたりすると、セーブデータは失われます。

**Memory card** の **Export saves** でバックアップのzipをダウンロードでき、**Import saves…** で復元できます。ブラウザのデータを消去する前に、必ずバックアップを取ってください。

> **ネイティブ版Emueraからのインポート** emuera-web は独自のセーブ形式を使うため、デスクトップ版Emueraの `.sav` ファイルをそのまま読み込むことはできません。変換機能（**Import sav folder zip…** と **Export sav folder zip**）はありますが、実験的なものです。元の `.sav` ファイルは必ず手元に残し、変換後のセーブだけに頼らないでください。どちらの方向の変換も、完全に一致するとは限りません。

## Features

### Resource Packs

A resource pack is an extra zip whose files are laid over the game's own files when the game loads, for example image packs, CSV data, or ERB code.

- Add packs under **Resource packs** with **Add pack zip…**. They are stored in your browser and are not tied to one game. the enabled list is applied to whatever game you load next.
- Packs apply in list order, and a later pack wins when two packs contain the same file. You can reorder, disable or remove a pack. Each entry shows its size and indicates if it carries code (ERB) or data (CSV).
- A pack can include a `pack.txt` at its root (name, author, version, game, url, description). It is only displayed in the list and is never loaded into the game.
- Changes take effect on the next load. Press **Apply: reload game** to reload the open game with the current pack list.

For more info on resource packs see the [wiki page.](https://github.com/exinfi/emuera-web/wiki/Resource-Packs)


### Translation

An optional, offline machine translation module for games. It is off by default. When enabled, text from the game is translated in your browser, on your device, and shown in a side panel; nothing is sent to any server, and the game itself is never altered. Results are rough and intended for getting general gist only.

- Translation needs two things, both added as zip files under **Translation** with **Add translation zip…**: the translation engine, and a language model (for example Japanese to English).
- The engine and the Japanese, Korean and Simplified Chinese to English models are in `other/translationpacks/`. The hosted page also offers **Load bundled translation files**, which adds the engine and the Japanese model for you. Builds you make yourself do not include this button unless you add the files to `bundled-assets/` (see `tools/build-site.mts`).
- Once loaded in your page, tick **Enable translation**. Translated lines appear in a panel.
    - If on mobile, the translation panel will take the form of an overlay panel, opened by clicking/swiping on the translation tab present on the left side of the main game display.
    - Otherwise, if your screen is wide enough you can enable it to be docked side-by-side like desktop.
- Translated lines are remembered per game so they are not translated twice. **Clear cached lines** deletes them.
- **Enable copy to clipboard** lets you tap a line in the panel to copy it, hold to copy from that line to the latest, or hold the latest line to copy the last 50.

For more information on in-game translation and how to build your own pack see the [wiki page.](https://github.com/exinfi/emuera-web/wiki/Translation)

### Widgets

On-screen controls to help play without a keyboard. All are optional and are configured under **Widgets** in the control panel.

- **Direction pad:** a cross of buttons that sends 8, 4, 5, 6 and 2. It can be dragged and resized, and each key can be changed. **Reset cross** restores it to its original state.
- **Custom buttons:** Attached to the direction pad settings. Add your own buttons that send a user set value.
- **Quick Input:** at the top, are buttons to send the last input again, 999, and a **+** button you can set. Tap **+** to record a custom value.

## Issues

### Known issues

- Plugin and Network commands are intentionally stubbed.
- **Map or text misalignment.** Many era games rely on MS Gothic as their default font. If this font is not present, the interpreter falls back to its internal BIZ UDGothic, which may have missing characters. This may cause misalignment in the display. You can add your own font under **Font**. That said, if your issue is still a bug, please report it.
- **"Missing sprites" or missing images messages.** The **dbg** button may show a warning naming images the game asked for but could not find. This is often a natural outcome of how many era games are written: they request images that were never shipped with the game (optional image packs, or graphics the author left out), and the original Emuera simply skips them. A game that runs normally is not affected. If images you do have are not showing, check that the game zip's folder layout is intact and that any resource pack is enabled, and report it if they still do not appear.

### Reporting a problem

Open an issue on this repository and include as necessary:

- the game's name and version, and which build of emuera-web you are using (shown at the bottom of the control panel);
- what you did, what you expected, and what happened instead;
- a **debug log** (below), and a **game snapshot** if the problem depends on the game's state.

The debug tools are in the **dbg** button in the top bar (your top bar must not be collapsed):

- **Debug** tab: engine and game information, plus any load errors and warnings. **Copy report** copies it as text.
- **Inputs** tab: the recent inputs you sent.
- **Export debug log** downloads a text file about what is happening right now: engine and game info, what the game is waiting for, the recent inputs, the last lines of screen text, the recent ERB function calls, and load errors and warnings. Type a short note in the box first and it goes at the top of the file. **Verbose** makes the lists longer (every load error and warning, the first and last 50 inputs, 200 lines of screen text, the last 200 ERB calls); use it when the normal log did not show the problem.
- **Export game snapshot** downloads a JSON copy of every game variable that differs from its default (characters, flags, tables, maps). It lets someone restore your exact game state to reproduce a problem. It holds no screen, call stack or files, at the time of export.
- **Crash snapshot** appears after a crash and holds the game state at that moment.

The log and snapshot contain text from the game and the inputs you typed, and the snapshot contains your game state. Look through them before you post them publicly. Your save files and the game itself are not included.

## Attribution

The interpreter's own code is licensed under the MIT License, Copyright (c) 2026 The emuera-web contributors. The license text is in the `LICENSE` file. Parts of the code that follow Emuera's structure also carry Emuera's license, given below.


### Emuera

This interpreter reimplements Emuera for the browser, in a different language (TypeScript) and with a different internal design. It aims to run games written for Emuera.

- **eramaker** is the original engine these games were first made for. Emuera is a separate program that runs eramaker's scripts. This project contains no eramaker code.
- **Emuera** is the program this interpreter reimplements. Its copyright and license are given below.
- **Emuera's branches** were built on its source by other authors, each adding their own features. This interpreter follows the behavior of the extended branches that are in common use. We treat the branches as derived from Emuera and apply Emuera's license to them broadly; their additions remain the work of their own authors.

Some parts of our code follow the structure of that source. We treat those parts as derived from it to fit our specific implementation, so the license below applies to them.

**The original Emuera license** (Copyright (C) 2008- MinorShift, 妊）|дﾟ)の中の人; zlib/libpng), reproduced in full and unaltered:

> Copyright (C) 2008- MinorShift, 妊）|дﾟ)の中の人
>
> 本ソフトウェアは「現状のまま」で、明示であるか暗黙であるかを問わず、何らの保証もなく提供されます。 本ソフトウェアの使用によって生じるいかなる損害についても、作者は一切の責任を負わないものとします。
>
> 以下の制限に従う限り、商用アプリケーションを含めて、本ソフトウェアを任意の目的に使用し、自由に改変して再頒布することをすべての人に許可します。
>
> 1. 本ソフトウェアの出自について虚偽の表示をしてはなりません。あなたがオリジナルのソフトウェアを作成したと主張してはなりません。 あなたが本ソフトウェアを製品内で使用する場合、製品の文書に謝辞を入れていただければ幸いですが、必須ではありません。
> 2. ソースを変更した場合は、そのことを明示しなければなりません。オリジナルのソフトウェアであるという虚偽の表示をしてはなりません。
> 3. ソースの頒布物から、この表示を削除したり、表示の内容を変更したりしてはなりません。

In plain English (unoffical translation): the software is provided as is with no warranty; anyone may use it for any purpose and modify and redistribute it, provided they do not claim to be the original author, they say when they have changed the source, and they keep this notice with any distribution of the source.

Games you load are the work of their own authors and are under their own terms. This project has no connection with them and does not claim any rights in them.

### Components included in the page

| Component                            | Used for                      | License                                                      | Copyright                                                                             |
| ------------------------------------ | ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| JSZip 3.10.1                         | reading and writing zip files | MIT (the project is dual-licensed MIT or GPLv3; MIT is used) | (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso      |
| pako (part of JSZip)                 | zip compression               | MIT                                                          | (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn                                       |
| BIZ UDGothic (Regular, Bold; subset) | default text font             | SIL Open Font License 1.1                                    | 2022 The BIZ UDGothic Project Authors                                                 |
| DotGothic16 (subset)                 | optional pixel-style font     | SIL Open Font License 1.1                                    | 2020 The DotGothic16 Project Authors, https://github.com/fontworks-fonts/DotGothic16/ |

The two font files are reduced copies (subsets) of the original fonts, which the Open Font License permits. The OFL texts are in `public/assets/font/`.

### Optional translation components

All files in this section are included **unmodified**, as released by their authors, and are licensed under the Mozilla Public License 2.0. The source form of every MPL-licensed file is available from the addresses below.

| File                     | What it is                                                                                                                                                                                                                | Source                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `translation.engine.zip` | the Bergamot translation engine (WebAssembly and its JavaScript wrapper), npm package @browsermt/bergamot-translator 0.4.9 (the three files are the package's `worker/` files), whose code reports build `v0.4.5+4917c11` | https://www.npmjs.com/package/@browsermt/bergamot-translator and https://github.com/browsermt/bergamot-translator |
| `translation.ja-en.zip`  | Japanese to English model, vocabulary and shortlist from Mozilla Firefox Translations                                                                                                                                     | https://mozilla.github.io/translations/firefox-models/                                                                                           |
| `translation.ko-en.zip` | Korean to English model, vocabulary and shortlist from Mozilla Firefox Translations | https://mozilla.github.io/translations/firefox-models/ |
| `translation.zh-Hans-en.zip` | Simplified Chinese to English model, vocabulary and shortlist from Mozilla Firefox Translations | https://mozilla.github.io/translations/firefox-models/ |


Mozilla, Firefox and Bergamot are the names of their respective owners. This project is not affiliated with or endorsed by them.
