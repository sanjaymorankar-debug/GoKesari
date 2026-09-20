/**
 * Streaming delimited-text parser (CSV / TSV) with bounded memory.
 *
 * The bulk exports this platform reads are gigabytes long, so rows are yielded one
 * at a time from an async stream and nothing is buffered beyond the current row.
 *
 * Quoting is lenient in the way real-world exports need: a quote is only special
 * at the START of a field. `12" pizza` in an unquoted field is literal text, and
 * a quoted field may contain the delimiter, newlines and doubled quotes ("").
 */

export class DelimitedParseError extends Error {}

export interface DelimitedOptions {
  delimiter?: string;
  /** Guard against an unbalanced quote swallowing the rest of the file. */
  maxFieldLength?: number;
}

export async function* parseDelimited(
  chunks: AsyncIterable<Buffer | Uint8Array | string>,
  options: DelimitedOptions = {},
): AsyncGenerator<string[]> {
  const delimiter = options.delimiter ?? "\t";
  const maxField = options.maxFieldLength ?? 1_000_000;
  const decoder = new TextDecoder("utf-8");

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true; // at the first character of a field
  let afterClosingQuote = false;
  let pendingCR = false;

  function* endRow(): Generator<string[]> {
    row.push(field);
    // Skip completely blank lines (a lone empty field).
    if (!(row.length === 1 && row[0] === "")) yield row;
    row = [];
    field = "";
    fieldStart = true;
    afterClosingQuote = false;
  }

  const feed = function* (text: string): Generator<string[]> {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (pendingCR) {
        pendingCR = false;
        if (c === "\n") continue;
      }

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else if (i + 1 >= text.length) {
            // Quote is the last char of this chunk: cannot tell "" from close yet.
            // Defer by re-inserting a marker handled on the next chunk.
            inQuotes = false;
            afterClosingQuote = true;
          } else {
            inQuotes = false;
            afterClosingQuote = true;
          }
        } else {
          field += c;
          if (field.length > maxField) throw new DelimitedParseError("field exceeds maxFieldLength (unbalanced quote?)");
        }
        continue;
      }

      if (afterClosingQuote) {
        if (c === '"') {
          // A doubled quote split across chunks: it was an escaped quote.
          field += '"';
          inQuotes = true;
          afterClosingQuote = false;
          continue;
        }
        if (c === delimiter || c === "\n" || c === "\r") {
          afterClosingQuote = false;
        } else {
          // Text straight after a closing quote: the quote was literal, not structural.
          field = '"' + field + '"';
          afterClosingQuote = false;
        }
      }

      if (c === delimiter) {
        row.push(field);
        field = "";
        fieldStart = true;
      } else if (c === "\n") {
        yield* endRow();
      } else if (c === "\r") {
        pendingCR = true;
        yield* endRow();
      } else if (c === '"' && fieldStart) {
        inQuotes = true;
        fieldStart = false;
      } else {
        field += c;
        fieldStart = false;
        if (field.length > maxField) throw new DelimitedParseError("field exceeds maxFieldLength");
      }
    }
  };

  // Decode across chunk boundaries without splitting a multi-byte character.
  let pendingBytes: Uint8Array | null = null;
  for await (const chunk of chunks) {
    let text: string;
    if (typeof chunk === "string") {
      text = chunk;
    } else {
      let bytes: Uint8Array = chunk;
      if (pendingBytes) {
        const merged = new Uint8Array(pendingBytes.length + bytes.length);
        merged.set(pendingBytes);
        merged.set(bytes, pendingBytes.length);
        bytes = merged;
        pendingBytes = null;
      }
      // Hold back an incomplete trailing UTF-8 sequence.
      let end = bytes.length;
      let back = 0;
      while (back < 3 && end - back > 0 && (bytes[end - back - 1] & 0xc0) === 0x80) back++;
      if (end - back > 0) {
        const lead = bytes[end - back - 1];
        const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (need > back + 1) {
          end = end - back - 1;
          pendingBytes = bytes.slice(end);
        }
      }
      text = decoder.decode(bytes.subarray(0, end));
    }
    yield* feed(text);
  }
  if (pendingBytes) yield* feed(decoder.decode(pendingBytes));

  if (inQuotes) throw new DelimitedParseError("unterminated quoted field at end of input");
  if (field !== "" || row.length > 0) yield* endRow();
}

/** Yields objects keyed by the header row. Rows with the wrong width are reported, not silently padded. */
export async function* parseDelimitedWithHeader(
  chunks: AsyncIterable<Buffer | Uint8Array | string>,
  options: DelimitedOptions & { onBadRow?: (rowNumber: number, width: number, expected: number) => void } = {},
): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  let n = 0;
  for await (const cells of parseDelimited(chunks, options)) {
    n++;
    if (!header) {
      header = cells.map((h) => h.trim());
      continue;
    }
    if (cells.length !== header.length) {
      options.onBadRow?.(n, cells.length, header.length);
      continue;
    }
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i];
    yield obj;
  }
}
