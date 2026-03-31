export function askedForKaleToken(text: string): boolean {
  const normalized = normalizeOnboardingText(text);
  const mentionsConnectUrl = /https?:\/\/[^\s)]+\/connect\b/.test(normalized)
    || normalized.includes("/kale/connect");
  const mentionsGenerateToken = /\bgenerate (?:a )?token\b/.test(normalized)
    || /\bclick (?:the )?generate token\b/.test(normalized);
  const mentionsPasteBack = /\bpaste (?:it|the token)(?: back)?(?: here)?\b/.test(normalized);
  const mentionsSignIn = /\bsign in\b/.test(normalized);

  return mentionsPasteBack && (mentionsConnectUrl || mentionsGenerateToken || mentionsSignIn);
}

export function askedForKaleHandoff(text: string): boolean {
  const normalized = normalizeOnboardingText(text);
  return askedForKaleToken(text)
    || normalized.includes("complete the browser sign-in flow")
    || normalized.includes("browser sign-in")
    || normalized.includes("open this url in your browser")
    || normalized.includes("requires authentication using")
    || normalized.includes("authorize kale by opening this url in your browser")
    || normalized.includes("authorize cail by opening this url in your browser");
}

function normalizeOnboardingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
