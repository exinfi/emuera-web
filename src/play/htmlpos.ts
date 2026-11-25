/**
 * <button|nonbutton pos=N>: N is a horizontal position in 1/100 of the font size, so the part starts at N * fontSize / 100 pixels
 * (ConsoleButtonString.LockPointX in EM+EE, HtmlManager in Emuera.NET). The fraction is kept: Emuera carries it to the next part as a sub-pixel.
 */
export const posToPx = (pos: number, fontSize: number): number => (pos * fontSize) / 100;
