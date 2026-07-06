declare module 'input' {
  export const text: (prompt?: string) => Promise<string>;
  export const password: (prompt?: string) => Promise<string>;
  export const confirm: (prompt?: string) => Promise<boolean>;
  export const select: (prompt: string, choices: string[]) => Promise<string>;
}