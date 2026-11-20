/** The part of `word-extractor` (no bundled types) that `document-text.ts` uses. */
declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}
