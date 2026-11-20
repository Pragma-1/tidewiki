// Just the parts of these libraries Tidewiki uses (neither ships TypeScript types).
declare module "pdfmake" {
  type FontFiles = { normal: string; bold: string; italics: string; bolditalics: string };
  const pdfmake: {
    setFonts(fonts: Record<string, FontFiles>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(doc: object, options?: object): { getBuffer(): Promise<Buffer> };
  };
  export default pdfmake;
}

declare module "fontkit" {
  export function openSync(path: string): { hasGlyphForCodePoint(codePoint: number): boolean };
}
