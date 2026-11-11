/** What the engine itself sends a session to resume it. */
export const AUTO_RESUME_PROMPT =
  'The provider usage limit that interrupted this task has reset. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';
export const TRANSIENT_RETRY_PROMPT =
  'Your previous turn stopped on a temporary provider error (overloaded, unreachable or a login refresh race), not on anything in the task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';
export const RESTART_CONTINUATION_PROMPT =
  'The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context, then continue the task from where you left off.';
export const ENGINE_CONTINUATION_PROMPTS: readonly string[] = [AUTO_RESUME_PROMPT, TRANSIENT_RETRY_PROMPT, RESTART_CONTINUATION_PROMPT];
