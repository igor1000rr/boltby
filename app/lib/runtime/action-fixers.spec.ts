import { describe, expect, it } from 'vitest';
import {
  extractTailwindPlugins,
  fixPackageJson,
  fixTailwindOrPostcssConfig,
  sanitizeNpmCommand,
} from './action-fixers';

describe('action-fixers', () => {
  describe('sanitizeNpmCommand', () => {
    it('fixes known wrong package names and removes invalid @types packages', () => {
      const input = 'npm install @lucide/react @types/lucide-react react';
      const output = sanitizeNpmCommand(input);

      expect(output).toContain('npm install');
      expect(output).toContain('lucide-react');
      expect(output).not.toContain('@lucide/react');
      expect(output).not.toContain('@types/lucide-react');
      expect(output).toContain('react');
    });

    it('returns non-install commands unchanged', () => {
      const input = 'npm run dev';
      expect(sanitizeNpmCommand(input)).toBe(input);
    });
  });

  describe('extractTailwindPlugins', () => {
    it('extracts require plugins and ignores postcss core deps', () => {
      const content = `
        module.exports = {
          plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
        };
        const post = require('postcss');
        const auto = require('autoprefixer');
      `;
      const plugins = extractTailwindPlugins(content);

      expect(plugins).toEqual(['tailwindcss-animate', '@tailwindcss/typography']);
    });
  });

  describe('fixTailwindOrPostcssConfig', () => {
    it('converts defineConfig export to module.exports and wraps plugin requires', () => {
      const content = `
import { defineConfig } from 'tailwindcss';
export default defineConfig({
  plugins: [require('tailwindcss-animate')],
});
`;
      const fixed = fixTailwindOrPostcssConfig(content, 'tailwind.config.js');

      expect(fixed).toContain('module.exports =');
      expect(fixed).not.toContain("import { defineConfig } from 'tailwindcss'");
      expect(fixed).toContain("console.warn('[tailwind plugin missing]'");
    });
  });

  describe('fixPackageJson', () => {
    it('replaces banned framework deps with Vite + React baseline', () => {
      const pkg = JSON.stringify({
        name: 'demo',
        dependencies: { astro: '^5.0.0' },
        scripts: { dev: 'astro dev' },
      });
      const fixed = JSON.parse(fixPackageJson(pkg));

      expect(fixed.dependencies.astro).toBeUndefined();
      expect(fixed.dependencies.react).toBeDefined();
      expect(fixed.dependencies['react-dom']).toBeDefined();
      expect(fixed.devDependencies.vite).toBeDefined();
      expect(fixed.devDependencies['@vitejs/plugin-react']).toBeDefined();
      expect(fixed.scripts.dev).toBe('vite');
      expect(fixed.scripts.build).toBe('vite build');
      expect(fixed.scripts.start).toBe('vite preview');
    });
  });
});
