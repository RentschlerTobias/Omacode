// A name that looks like it holds a secret: such a variable is granted by the user only, never by a judge.
const SECRET = /(TOKEN|SECRET|PASSW(OR)?D|PASS$|KEY$|_KEY_|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT)/i

export function looksSecret(name: string, value?: string): boolean {
  return SECRET.test(name) || (value !== undefined && /^[a-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value))
}
