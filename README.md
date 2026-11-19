# emuera-web

**[0]** https://exinfi.github.io/emuera-web/

## What is this?

emuera-web is a browser-based Emuera interpreter that aims to run era text games on a computer or a phone on a single webpage. Once the page has loaded, it runs entirely on your local device.

This is an independent project. It is unaffiliated with Emuera, its branches or any game. If there is an issue, the cause may be this program, so please report it here and not to those authors.


emuera-web は、eraゲームをパソコンやスマートフォンで動作させることを目指した、ブラウザベースのEmueraインタープリターです。ページの読み込みが完了した後は、すべてお使いの端末上で動作します。

これは独立したプロジェクトであり、Emuera、その派生版、およびいかなるゲームとも提携・関係していません。問題が発生した場合、原因は本プログラムにある可能性がありますので、Emuera（およびその派生版）やゲームの作者の方ではなく、こちらにご報告ください。

## How to Build

You need Node 22. Then:

```
npm install
npm run build:site
```

This writes `site/`, a site you can host on any static host, such as GitHub Pages. The player is a single file, `site/index.html`.

`npm run build:mobile` builds just that single-file player, to `dist-play/play.html`, without making `site/`.

If you are changing the code, there is a test suite to check your work. Run `npm run typecheck` and `npm test`; see `tests/README.md` for more details.

---

**I Just Want to Play Games:** Go to dist-play/play.html and drag that file on your browser. All features may not work.

## How to Use

### Quickstart
1. Open the page and press the menu button (the three bars) to show the control panel.
2. Under **Game**, press **Load game zip…** and pick your game's zip file. **You can also drop the zip on the page if your device supports it.**
    - A game zip is all the game files (ERB/ CSV/...) zipped together. If you got your game from a repo, that zip will (probably) work.
    - Most supported files (game, memory card, resource packs, language packs) can be drag and dropped in, otherwise use the respective load button.
3. The game supports both mouse input on desktop and tap input on mobile devices.
    - The keyboard icon can be used to show/hide the text input box.
    - If on mobile, the **L / R / H** button at the top left sets what a tap does: left click, right click, or hover (a long press does the other click).
4. **Reload Game** starts the loaded game again from the beginning.

The default options work for most games. If a game keeps its files in an unusual folder layout, you may need to turn on the extra file check in **Options**.


1. ページを開き、メニューボタン（三本線のアイコン）を押してコントロールパネルを表示します。
2. **Game** の **Load game zip…** を押して、ゲームのzipファイルを選びます。お使いの端末が対応していれば、zipファイルをページにドラッグ＆ドロップしても読み込めます。
    - ゲームのzipファイルとは、ゲームのファイル一式（ERB/ CSV/ など）をまとめてzip圧縮したものです。リポジトリから入手したゲームであれば、そのzipがおそらくそのまま使えます。
    - 対応しているファイル（ゲーム、メモリーカード、リソースパック、言語パック）の多くはドラッグ＆ドロップで読み込めます。できない場合は、それぞれの読み込みボタンを使ってください。
3. デスクトップではマウス操作、モバイル端末ではタップ操作の両方に対応しています。
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

- Add packs under **Resource packs** with **Add pack zip…**. Once enabled, they will apply to any game you load next.
- Packs apply in list order. A later pack's file will override an earlier one. You can reorder, disable or remove a pack. Each entry shows its size and indicates if it carries code (ERB) or data (CSV).
- A pack can include a `pack.txt` at its root (name, author, version, game, url, description). This file is not loaded into the game.
- Changes take effect on the next load. Press **Apply: reload game** to reload the open game with the current pack list.

For more info on resource packs see the [wiki page.](https://github.com/exinfi/emuera-web/wiki/Resource-Packs)


### Translation

An optional, offline machine translation module for games. When enabled, text from the game is translated in your browser, and shown in a side panel. Translations are local and the game itself is not altered. Results are rough and intended for getting the general idea only.

- Translation needs two things, both added as zip files under **Translation** with **Add translation zip…**:
    - the translation engine,
    - and a language model (for example Japanese to English).
- The engine and the Japanese, Korean and Simplified Chinese to English models are in `other/translationpacks/`. The hosted github page also offers **Load bundled translation files**, which adds the engine and the Japanese model for you. Builds you make yourself do not include this button unless you add the files to `bundled-assets/` (see `tools/build-site.mts`).

- Once loaded in your page, tick **Enable translation**. Translated lines will appear in a panel.
    - If on mobile, the translation panel will take the form of an overlay panel, opened by clicking/swiping on the translation tab present on the left side of the main game display.
    - Otherwise, if your screen is wide enough you can enable it to be docked side-by-side like desktop.
- **Enable copy to clipboard** lets you tap a line in the panel to copy it, hold to copy from that line to the latest, or hold the latest line to copy the last 50.

For more information on in-game translation and how to build your own pack see the [wiki page.](https://github.com/exinfi/emuera-web/wiki/Translation)

### Widgets

On-screen controls to help play without a keyboard and can be configured under **Widgets** in the control panel.

- **Direction pad:** a cross of buttons that sends 8, 4, 5, 6 and 2. It can be dragged and resized, and each key can be changed. **Reset cross** restores it to its original state.
- **Quick access button:** Header buttons to help with repetitive inputs. When enabled, a 'last action' button is enabled by default with the ability to add more buttons with your own user set value.

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

The log and snapshot contain text from the game and the inputs you typed, and the snapshot contains your game state. Look through them before you post them publicly. Your saved files and the game itself are not included.

## Attribution

The interpreter's own code is licensed under the MIT License, Copyright (c) 2026.


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

| Component                             | Used for                       | License                                                      | Copyright                                                                             |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| JSZip 3.10.1                          | reading and writing zip files  | MIT (the project is dual-licensed MIT or GPLv3; MIT is used) | (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso      |
| pako (part of JSZip)                  | zip compression                | MIT                                                          | (C) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn                                       |
| BIZ UDGothic | default text font              | SIL Open Font License 1.1                                    | 2022 The BIZ UDGothic Project Authors                                                 |
| BIZ UDPGothic | page font | SIL Open Font License 1.1                                    | 2022 The BIZ UDPGothic Project Authors                                                |
| DotGothic16                  | optional pixel-style font      | SIL Open Font License 1.1                                    | 2020 The DotGothic16 Project Authors, https://github.com/fontworks-fonts/DotGothic16/ |

The OFL texts are in `public/assets/font/`.

### Optional translation components

All files in this section are included **unmodified**, as released by their authors, and are licensed under the Mozilla Public License 2.0. 

- `translation.engine.zip` is the Bergamot translation engine (WebAssembly and its JavaScript wrapper): the three `worker/` files of the npm package [@browsermt/bergamot-translator](https://www.npmjs.com/package/@browsermt/bergamot-translator) 0.4.9 (source: [browsermt/bergamot-translator](https://github.com/browsermt/bergamot-translator)).
- `translation.ja-en.zip`, `translation.ko-en.zip` and `translation.zh-Hans-en.zip` are the Japanese, Korean and Simplified Chinese to English models, with their vocabulary and shortlist files, from [Mozilla Firefox Translations](https://mozilla.github.io/translations/firefox-models/).

Mozilla, Firefox and Bergamot are trademarks or names of their respective owners. This project is not affiliated with or endorsed by them.