import { describe, expect, it } from 'vitest';
import { PromptLibrary, type PromptOptions } from './prompt-library';

const baseOptions: PromptOptions = {
  cwd: '/tmp/project',
  allowedHtmlElements: [],
  modificationTagName: 'mod',
};

describe('PromptLibrary', () => {
  it('returns prompt list with required ids', () => {
    const list = PromptLibrary.getList();
    const ids = list.map((item) => item.id);

    expect(ids).toContain('default');
    expect(ids).toContain('enhanced');
    expect(ids).toContain('optimized');
    expect(ids).toContain('compact');
  });

  it('throws for unknown prompt ids', () => {
    expect(() => PromptLibrary.getPropmtFromLibrary('missing-id', baseOptions)).toThrow('Prompt Now Found');
  });

  it('returns a string for each known prompt id', () => {
    const ids = ['default', 'enhanced', 'optimized', 'compact'];

    for (const id of ids) {
      const value = PromptLibrary.getPropmtFromLibrary(id, baseOptions);
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(10);
    }
  });
});
