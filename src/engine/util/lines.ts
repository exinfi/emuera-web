/**
 * Splitting a text file into lines the way Emuera reads it (File.ReadAllLines / StreamReader.ReadLine): CRLF, LF and a lone CR each end a line,
 * and a leading BOM is not part of the text. Every CSV/ERB/config reader goes through this so old files with CR-only endings behave.
 */
export const splitLines = (text: string): string[] => text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
