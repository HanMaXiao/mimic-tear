/**
 * Repairs mojibake produced by reading UTF-8 bytes as GBK.
 *
 * The Goal-mode plan writer stores some log files as UTF-16LE whose *characters* are already
 * mojibake: the original UTF-8 bytes were decoded as GBK before being written. Decoding such a
 * file as UTF-16LE therefore yields ASCII that is correct and CJK that is garbage.
 *
 * The corruption is reversible because GBK is a bijection on the byte pairs it maps:
 *   original_utf8_bytes --GBK-decode--> mojibake_string --GBK-encode--> original_utf8_bytes
 *
 * Two details make it lossy, and both are handled here:
 *  - A byte GBK could not pair (a UTF-8 run of odd length) became a literal `?` in the mojibake
 *    string, so that byte is gone. It is recovered by solving for the byte that completes the
 *    interrupted UTF-8 sequence, preferring characters seen in known-clean sibling text.
 *  - Node ships a GBK *decoder* (ICU) but no GBK *encoder*, so the encoder is reconstructed at
 *    runtime by decoding every legal 2-byte GBK sequence once and inverting the result.
 *
 * The repair is accepted only when the reconstructed bytes form strictly valid UTF-8. That
 * makes the detector self-verifying: genuine mojibake round-trips to the original bytes, while
 * ordinary Chinese text re-encodes to GBK bytes that are essentially never valid UTF-8.
 */

let gbkEncoder = null;

/**
 * Build (once) a GBK encoder from Node's GBK decoder.
 * @returns {((text: string) => Uint8Array) | null} null when GBK is unavailable
 */
function getGbkEncoder() {
  if (gbkEncoder !== null) return gbkEncoder;

  let decoder;
  try {
    decoder = new TextDecoder('gbk', { fatal: false });
  } catch {
    gbkEncoder = false;
    return null;
  }

  const pairs = [];
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      pairs.push(lead, trail);
    }
  }

  const decoded = decoder.decode(new Uint8Array(pairs));
  const reverse = new Map();
  for (let i = 0; i < pairs.length / 2; i += 1) {
    const char = decoded[i];
    if (char === '\ufffd' || char === '?' || char === undefined) continue;
    if (!reverse.has(char)) reverse.set(char, [pairs[i * 2], pairs[i * 2 + 1]]);
  }

  if (reverse.size === 0) {
    gbkEncoder = false;
    return null;
  }

  gbkEncoder = (text) => {
    const bytes = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code < 0x80) {
        bytes.push(code);
        continue;
      }
      const found = reverse.get(char);
      if (found) bytes.push(found[0], found[1]);
      else bytes.push(0x3f);
    }
    return new Uint8Array(bytes);
  };
  return gbkEncoder;
}

/**
 * Repair mojibake text.
 *
 * @param {string} text
 * @param {Set<string>} [vocabulary] characters known to occur in clean text of the same
 *   artifact family; used to disambiguate bytes lost to odd-length UTF-8 runs.
 * @returns {string} the repaired text, or the input unchanged when it was not mojibake
 */
export function repairMojibake(text, vocabulary) {
  if (!text) return text;
  // ASCII-only text can never be mojibake.
  if (!/[\u0080-\uffff]/.test(text)) return text;

  const encode = getGbkEncoder();
  if (!encode) return text;

  // Re-encode to the original byte stream, remembering where a byte was lost.
  const bytes = [];
  const lostCandidates = [];
  for (const char of text) {
    if (char === '\ufffd') {
      lostCandidates.push(bytes.length);
      bytes.push(0x3f);
      continue;
    }
    if (char === '?') {
      // Either a literal question mark or a byte GBK could not pair.
      lostCandidates.push(bytes.length);
      bytes.push(0x3f);
      continue;
    }
    const encoded = encode(char);
    for (const byte of encoded) bytes.push(byte);
  }

  const buffer = new Uint8Array(bytes);
  if (buffer.length === 0) return text;

  // Only a `?` that interrupts a UTF-8 sequence can be a lost byte.
  const unknowns = lostCandidates.filter((index) => interruptsSequence(buffer, index));

  for (const index of unknowns) {
    buffer[index] = solveLostByte(buffer, index, vocabulary);
  }

  // The repaired text is only accepted when it is strictly valid UTF-8. A genuine mojibake
  // round-trips to the original bytes; ordinary Chinese re-encodes to bytes that are not.
  try {
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (repaired === text) return text;
    return restoreSeparators(repaired);
  } catch {
    return text;
  }
}

/**
 * Put back the space that the corruption ate between a CJK run and a Latin token.
 *
 * When GBK cannot pair a byte it consumes the byte after it as well, so a separator such as
 * the space in "跨重启 PID" is lost. The text then reads "跨重启PID". A CJK character directly
 * followed by a Latin letter or digit is always a missing separator in this corpus, and
 * Chinese typography puts a space there anyway.
 */
function restoreSeparators(text) {
  return text.replace(/([\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef])([A-Za-z0-9+])/g, '$1 $2');
}

/**
 * Does the byte at `index` interrupt a UTF-8 sequence?
 *
 * The lost byte is always a continuation byte: GBK pairs a UTF-8 run from its start, so an
 * odd-length run loses only its final byte. A `?` therefore replaced a lost byte exactly
 * when the UTF-8 sequence introduced by the preceding lead byte is not yet complete.
 */
function interruptsSequence(buffer, index) {
  const start = sequenceStartBefore(buffer, index);
  if (start === null) return false;
  const length = sequenceLength(buffer[start]);
  if (length <= 1) return false;
  // The sequence occupies [start, start + length - 1]. If that range ends at or after
  // `index`, the sequence is missing this byte.
  return start + length - 1 >= index;
}

/**
 * The lead byte of the UTF-8 sequence that reaches `index`, or null when the byte before
 * `index` does not belong to a multi-byte sequence.
 */
function sequenceStartBefore(buffer, index) {
  let start = index - 1;
  if (start < 0) return null;
  if ((buffer[start] & 0xc0) !== 0x80) return null;
  while (start > 0 && (buffer[start] & 0xc0) === 0x80) start -= 1;
  return start;
}

/**
 * Choose the byte that was lost to an odd-length UTF-8 run.
 *
 * The lost byte almost always sits inside a multi-byte sequence, so it must be a UTF-8
 * continuation byte (0x80-0xBF). Among those the original value is ambiguous: every
 * continuation byte produces a valid character. The tie is broken against the clean sibling
 * text — the candidate whose decoding reproduces the most known character sequences wins.
 */
function solveLostByte(buffer, index, vocabulary) {
  const start = sequenceStartBefore(buffer, index) ?? index;
  const length = sequenceLength(buffer[start]);
  const offset = index - start;
  const needsContinuation = length > 1 && offset > 0 && offset < length;

  let best = 0x3f;
  let bestScore = -Infinity;

  for (let candidate = 0; candidate < 0x100; candidate += 1) {
    if (candidate === 0x00) continue;
    if (needsContinuation && (candidate < 0x80 || candidate > 0xbf)) continue;
    buffer[index] = candidate;
    const score = scoreCandidate(buffer, start, length, vocabulary);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  buffer[index] = best;
  return best;
}

/** Length of the UTF-8 sequence introduced by a lead byte. */
function sequenceLength(lead) {
  if (lead >= 0xc0 && lead < 0xe0) return 2;
  if (lead >= 0xe0 && lead < 0xf0) return 3;
  if (lead >= 0xf0 && lead < 0xf8) return 4;
  return 1;
}

/**
 * Score a candidate byte.
 *
 * With a clean sibling text available, the decisive signal is how many known character
 * sequences the whole decoded text reproduces: the correct byte restores words the sibling
 * text also contains. A single character is not enough — the right and the wrong character
 * are often both present somewhere in the sibling text.
 */
function scoreCandidate(buffer, start, length, vocabulary) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

  if (vocabulary?.ngrams?.size) {
    let score = 0;
    for (let i = 0; i + 3 <= text.length; i += 1) {
      if (vocabulary.ngrams.has(text.slice(i, i + 3))) score += 3;
    }
    for (let i = 0; i + 2 <= text.length; i += 1) {
      if (vocabulary.ngrams.has(text.slice(i, i + 2))) score += 1;
    }
    return score;
  }

  // No sibling text: fall back to whether the completed sequence decodes cleanly and
  // whether the resulting character is ordinary Chinese.
  const end = Math.min(buffer.length, start + length);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(start, end));
  const loss = (decoded.match(/\ufffd/g) ?? []).length;

  let score = 100 - loss * 30;
  if (loss === 0 && decoded.length > 0) {
    const first = decoded[0];
    score += 20;
    if (vocabulary?.chars?.has(first)) score += 40;
    else if (/[\u4e00-\u9fff]/.test(first)) score += 10;
  }
  return score;
}

/**
 * Build the reference used to disambiguate repaired characters.
 *
 * `chars` holds every non-ASCII character of the clean text. `ngrams` holds its character
 * sequences, which is what actually disambiguates a lost byte: the correct candidate
 * reproduces words the clean text also contains, and a wrong one does not.
 *
 * @param {string} text
 * @returns {{ chars: Set<string>, ngrams: Set<string> }}
 */
export function buildVocabulary(text) {
  const chars = new Set();
  const ngrams = new Set();
  if (!text) return { chars, ngrams };

  for (const char of text) {
    if (char >= '\u0080') chars.add(char);
  }
  for (let i = 0; i + 2 <= text.length; i += 1) ngrams.add(text.slice(i, i + 2));
  for (let i = 0; i + 3 <= text.length; i += 1) ngrams.add(text.slice(i, i + 3));
  return { chars, ngrams };
}
