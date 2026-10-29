/** Filename guard against accidental secret reads; not a security boundary. */
const SENSITIVE_FILE_NAME = /^(?:\.env(?:\..*|\*)?|id_rsa|id_ed25519|id_ecdsa|id_dsa|.*\.(?:pem|key|p12|pfx)|\.netrc|\.credentials\.json)$/iu;

export function hasSensitiveFileName(candidate: string): boolean {
  return candidate.split(/[\\/]/u).some((segment) => SENSITIVE_FILE_NAME.test(segment));
}

/** Use command delimiters as filename boundaries, preserving wildcard patterns. */
export function textNamesSensitiveFile(text: string): boolean {
  return text.split(/[\s'"`=<>()[\]{},;:|&\\/]+/u).some((segment) => SENSITIVE_FILE_NAME.test(segment));
}
