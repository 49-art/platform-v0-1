/**
 * Message pipeline checks that run inline in the ChatRoom (spec 6: "contact-detail shield +
 * keyword flags run inline").
 *
 * Two different jobs:
 *  - The CONTACT SHIELD blocks contact details until both people are verified and have both
 *    consented to swap (spec 1: "Verify before you meet"; spec 9: off-platform contact).
 *  - KEYWORD FLAGS never block. They raise scam / commercial-sex / safety signals for moderators
 *    and feed the sender's risk score (spec 8: "Scam and spam flags").
 */

export type ShieldHit = "phone" | "email" | "url" | "handle" | "messaging_app";

export type FlagCode =
  | "money_request"
  | "crypto_or_investment"
  | "gift_card"
  | "commercial_sex"
  | "off_platform_push"
  | "underage_signal"
  | "threat"
  | "link"
  | "copy_paste";

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", nought: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", hundred: "00", thousand: "000",
};

/** Collapse the usual evasion tricks: spaced-out digits, number words, "dot"/"at" spelled out. */
export function normaliseForShield(text: string): string {
  let t = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/\b(zero|oh|nought|one|two|three|four|five|six|seven|eight|nine|hundred|thousand)\b/g, (w) => NUMBER_WORDS[w] ?? w);
  // "double 7" -> "77", "triple 0" -> "000"
  t = t.replace(/\bdouble\s+(\d)/g, "$1$1").replace(/\btriple\s+(\d)/g, "$1$1$1");
  t = t.replace(/\s*\(?\b(dot|d0t)\b\)?\s*/g, ".").replace(/\s*\(?\b(at)\b\)?\s*(?=[a-z0-9-]+\.)/g, "@");
  return t;
}

const digitsOnly = (s: string) => s.replace(/\D/g, "");

export function detectContactDetails(text: string): ShieldHit[] {
  const hits = new Set<ShieldHit>();
  const t = normaliseForShield(text);

  // Phone: 9+ digits once separators are stripped from any run of digits / separators.
  for (const run of t.match(/(?:\+?\d[\s().\-_/,*]*){9,}/g) ?? []) {
    const d = digitsOnly(run);
    if (d.length >= 9 && d.length <= 15) hits.add("phone");
  }
  // Digits scattered through words ("0 7 7 0 0 call me 9 0 0 1 2 3")
  if (!hits.has("phone") && digitsOnly(t).length >= 10 && /\b(call|text|ring|number|whats\s*app|mobile|phone|msg)\b/.test(t)) hits.add("phone");

  if (/[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/.test(t)) hits.add("email");
  if (/\b(?:https?:\/\/|www\.)\S+/.test(t) || /\b[a-z0-9-]{2,}\.(?:com|co\.uk|uk|net|org|io|me|app|xyz|link|ly|gg|tv|info|biz|cc|to)\b/.test(t)) hits.add("url");
  if (/(^|\s)@[a-z0-9_.]{3,}/.test(t)) hits.add("handle");
  if (/\b(whats\s*app|telegram|signal|snap\s*chat|snap|insta(gram)?|kik|wechat|line id|discord|skype|tele\s*gram|t\.me|wa\.me)\b/.test(t) &&
      /\b(add|message|msg|find|hit|text|me on|my|is|id|username|user name|handle|@)\b/.test(t)) hits.add("messaging_app");
  // The app name used as a verb: "whatsapp me", "snap me", "telegram me".
  if (/\b(whats\s*app|telegram|snap\s*chat|snap|insta(gram)?|kik|wechat|discord|signal)\s+me\b/.test(t)) hits.add("messaging_app");

  return [...hits];
}

const leet = (t: string) => t.replace(/[01345 7@$]/g, (c) => (c === " " ? " " : (LEET[c] ?? c)));

const FLAG_PATTERNS: [FlagCode, RegExp][] = [
  ["money_request", /\b(send|lend|loan|wire|transfer|borrow|need|pay)\b.{0,30}\b(money|cash|funds|£|\$|€|pounds|quid|dollars|rent|bill|fee|fees|ticket|flight)\b|\b(western union|moneygram|bank details|sort code|account number|paypal|revolut|cash ?app|venmo|iban)\b/],
  ["crypto_or_investment", /\b(crypto|bitcoin|btc|ethereum|eth|usdt|tether|binance|coinbase|wallet address|forex|trading platform|invest(ment|ing)?|guaranteed return|passive income|mining pool)\b/],
  ["gift_card", /\b(gift ?cards?|steam card|itunes card|amazon voucher|google play card|voucher codes?|scratch the back)\b/],
  ["commercial_sex", /\b(rates?|per hour|ph|incall|outcall|escort(ing)?|gfe|pay ?to ?play|ppm|sugar (daddy|baby|mummy|mommy)|allowance|arrangement|donation for my time|roses)\b.{0,40}(\b(£|\$|€)?\d{2,}|\bmeet|\bhour|\bnight|\bmonthly|\bweekly)|\b(sugar (daddy|baby|mummy|mommy)|escort services?|incall|outcall)\b/],
  ["off_platform_push", /\b(lets?|can we|shall we|we should|better to|easier to|come|move|switch|continue|talk|chat)\b.{0,25}\b(whats\s*app|telegram|signal|snap(chat)?|insta(gram)?|kik|wechat|discord|off (this|the) (app|site)|another app|somewhere else)\b/],
  ["underage_signal", /\b(i'?m|i am|im|aged?)\s*(1[0-7]|[1-9])\b(?!\s*(years? (ago|in)|mins?|minutes?|hours?|miles?|km|st|kg|lbs?|stone))|\b(year (7|8|9|10|11)|gcses? next|sixth form next year|still at school|in high school|my mum won'?t let me|under ?age|not 18 yet)\b/],
  ["threat", /\b(i('?ll| will)|gonna|going to)\s+(kill|hurt|find|stab|rape|beat|ruin|destroy)\s+(you|u|your)\b|\b(kill yourself|kys|i know where you live|i'?ll post your (pics|photos|nudes)|leak your)\b/],
];

export function detectFlags(text: string): FlagCode[] {
  const t = leet(normaliseForShield(text));
  const flags = new Set<FlagCode>();
  for (const [code, re] of FLAG_PATTERNS) if (re.test(t)) flags.add(code);
  if (/\b(?:https?:\/\/|www\.)\S+/.test(t)) flags.add("link");
  return [...flags];
}

/** Stable fingerprint of a message for copy-paste detection across a sender's conversations. */
export function messageFingerprint(text: string): string | null {
  const t = normaliseForShield(text).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return t.length >= 40 ? t : null; // short greetings repeat innocently
}

export interface ShieldContext {
  /** Both people have a passed ID + liveness verification. */
  bothVerified: boolean;
  /** Both people hold an active phone_swap or x_link consent for this conversation. */
  bothConsentedToSwap: boolean;
}

export interface PipelineResult {
  allowed: boolean;
  blockedFor: ShieldHit[];
  flags: FlagCode[];
  /** Message for the sender when blocked. Explains the rule rather than just refusing. */
  notice?: string;
}

export function runMessagePipeline(text: string, ctx: ShieldContext): PipelineResult {
  const hits = detectContactDetails(text);
  const flags = detectFlags(text);
  const unlocked = ctx.bothVerified && ctx.bothConsentedToSwap;
  if (hits.length > 0 && !unlocked) {
    const what = hits.map((h) => ({ phone: "a phone number", email: "an email address", url: "a link", handle: "a username", messaging_app: "another app's contact" })[h]).join(", ");
    return {
      allowed: false,
      blockedFor: hits,
      flags: [...new Set<FlagCode>([...flags, "off_platform_push"])],
      notice: ctx.bothVerified
        ? `That looks like ${what}. Contact details stay private until you both agree to swap. Use "Swap contact details" in this chat.`
        : `That looks like ${what}. Contact details unlock after you are both ID-verified and both agree to swap. This protects you from scams.`,
    };
  }
  return { allowed: true, blockedFor: [], flags };
}

/** Weight of each flag in the sender's risk score (spec 8). */
export const FLAG_RISK: Record<FlagCode, number> = {
  money_request: 25,
  crypto_or_investment: 25,
  gift_card: 30,
  commercial_sex: 35,
  off_platform_push: 10,
  underage_signal: 60,
  threat: 60,
  link: 5,
  copy_paste: 15,
};
