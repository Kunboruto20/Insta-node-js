export class InstagramIdCodec {
  static ENCODING_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** Covert a numeric value to a shortcode. */
  static encode(num: string | number | bigint, alphabet: string = InstagramIdCodec.ENCODING_CHARS): string {
    let n = BigInt(num);
    if (n === 0n) return alphabet[0];
    const arr: string[] = [];
    const base = BigInt(alphabet.length);
    while (n) {
      const rem = n % base;
      n = n / base;
      arr.push(alphabet[Number(rem)]);
    }
    arr.reverse();
    return arr.join('');
  }

  /** Covert a shortcode to a numeric value (as string, since IDs exceed 2^53). */
  static decode(shortcode: string, alphabet: string = InstagramIdCodec.ENCODING_CHARS): string {
    const base = BigInt(alphabet.length);
    let num = 0n;
    for (const char of shortcode) {
      const idx = alphabet.indexOf(char);
      if (idx < 0) throw new Error(`ValueError: substring not found (${char})`);
      num = num * base + BigInt(idx);
    }
    return num.toString();
  }
}
