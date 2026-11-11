import { describe, expect, it } from 'vitest';
import { HANDOFF_INSTRUCTIONS } from '../handoff.ts';

/** Every agent gets the condensed resource rules (docs/skorowidny-cezar/agent-resource-discipline.md). */
describe('HANDOFF_INSTRUCTIONS resource rules', () => {
  it('carries the process, memory, disk and output rules', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('## Resources (cezar)');
    expect(HANDOFF_INSTRUCTIONS).toMatch(/Never detach work that outlives your turn/);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/MemoryMax=8G/);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/df -h \./);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/Never put images, base64/);
  });

  it('renders shell snippets literally, with no template escapes left behind', () => {
    expect(HANDOFF_INSTRUCTIONS).toContain('`ps -u "$USER" -o pid,etime,rss,args`');
    expect(HANDOFF_INSTRUCTIONS).not.toContain('\\`');
  });
});
