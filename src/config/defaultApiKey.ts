/** Baked in at package time from a local, gitignored .env — never committed. Empty in dev builds without one. */
export const DEFAULT_GROQ_API_KEY: string = process.env.DEFAULT_GROQ_API_KEY || '';
