import { globSync } from 'fast-glob';
import fs from 'node:fs/promises';
import { basename } from 'node:path';
import { defineConfig, presetIcons, presetUno, transformerDirectives } from 'unocss';

const iconPaths = globSync('./icons/*.svg');

const collectionName = 'bolt';

const customIconCollection = iconPaths.reduce(
  (acc, iconPath) => {
    const [iconName] = basename(iconPath).split('.');

    acc[collectionName] ??= {};
    acc[collectionName][iconName] = async () => fs.readFile(iconPath, 'utf8');

    return acc;
  },
  {} as Record<string, Record<string, () => Promise<string>>>,
);

const BASE_COLORS = {
  white: '#F0F0F5',
  gray: {
    50: '#1E1E2E',
    100: '#1A1A2A',
    200: '#16162A',
    300: '#2A2A40',
    400: '#8B8BA3',
    500: '#6E6E8A',
    600: '#9090A8',
    700: '#2A2A3E',
    800: '#141425',
    900: '#0F0F1E',
    950: '#0A0A14',
  },
  accent: {
    50: '#FFF8E1',
    100: '#FFECB3',
    200: '#FFE082',
    300: '#FFD54F',
    400: '#FFCA28',
    500: '#FFD700',
    600: '#F4A836',
    700: '#E8A317',
    800: '#C68A10',
    900: '#8B6914',
    950: '#4A3500',
  },
  green: {
    50: '#E8FFF3',
    100: '#B3FFD9',
    200: '#66FFAA',
    300: '#33FF99',
    400: '#00FF88',
    500: '#00E67A',
    600: '#00CC6A',
    700: '#009950',
    800: '#006638',
    900: '#004D2A',
    950: '#002615',
  },
  orange: {
    50: '#FFF3E0',
    100: '#FFE0B2',
    200: '#FFCC80',
    300: '#FFB74D',
    400: '#FFA726',
    500: '#FF9800',
    600: '#FB8C00',
    700: '#F57C00',
    800: '#EF6C00',
    900: '#E65100',
  },
  red: {
    50: '#FFE8E8',
    100: '#FFC1C1',
    200: '#FF9A9A',
    300: '#FF6B6B',
    400: '#FF5252',
    500: '#FF3838',
    600: '#E62E2E',
    700: '#CC2424',
    800: '#991B1B',
    900: '#661212',
    950: '#330909',
  },
};

const PURPLE_TO_GOLD = {
  50: '#FFF8E1',
  100: '#FFECB3',
  200: '#FFE082',
  300: '#FFD54F',
  400: '#FFCA28',
  500: '#FFD700',
  600: '#F4A836',
  700: '#E8A317',
  800: '#C68A10',
  900: '#8B6914',
};

const COLOR_PRIMITIVES = {
  ...BASE_COLORS,
  purple: PURPLE_TO_GOLD,
  alpha: {
    white: generateAlphaPalette(BASE_COLORS.white),
    gray: generateAlphaPalette(BASE_COLORS.gray[900]),
    red: generateAlphaPalette(BASE_COLORS.red[500]),
    accent: generateAlphaPalette(BASE_COLORS.accent[500]),
  },
};

export default defineConfig({
  safelist: [...Object.keys(customIconCollection[collectionName] || {}).map((x) => `i-bolt:${x}`)],
  shortcuts: {
    'bolt-ease-cubic-bezier': 'ease-[cubic-bezier(0.4,0,0.2,1)]',
    'transition-theme': 'transition-[background-color,border-color,color] duration-150 bolt-ease-cubic-bezier',
    kdb: 'bg-bolt-elements-code-background text-bolt-elements-code-text py-1 px-1.5 rounded-md',
    'max-w-chat': 'max-w-[var(--chat-max-width)]',
  },
  rules: [
    /**
     * This shorthand doesn't exist in Tailwind and we overwrite it to avoid
     * any conflicts with minified CSS classes.
     */
    ['b', {}],
  ],
  theme: {
    colors: {
      ...COLOR_PRIMITIVES,
      bolt: {
        elements: {
          borderColor: 'var(--bolt-elements-borderColor)',
          borderColorActive: 'var(--bolt-elements-borderColorActive)',
          background: {
            depth: {
              1: 'var(--bolt-elements-bg-depth-1)',
              2: 'var(--bolt-elements-bg-depth-2)',
              3: 'var(--bolt-elements-bg-depth-3)',
              4: 'var(--bolt-elements-bg-depth-4)',
            },
          },
          textPrimary: 'var(--bolt-elements-textPrimary)',
          textSecondary: 'var(--bolt-elements-textSecondary)',
          textTertiary: 'var(--bolt-elements-textTertiary)',
          code: {
            background: 'var(--bolt-elements-code-background)',
            text: 'var(--bolt-elements-code-text)',
          },
          button: {
            primary: {
              background: 'var(--bolt-elements-button-primary-background)',
              backgroundHover: 'var(--bolt-elements-button-primary-backgroundHover)',
              text: 'var(--bolt-elements-button-primary-text)',
            },
            secondary: {
              background: 'var(--bolt-elements-button-secondary-background)',
              backgroundHover: 'var(--bolt-elements-button-secondary-backgroundHover)',
              text: 'var(--bolt-elements-button-secondary-text)',
            },
            danger: {
              background: 'var(--bolt-elements-button-danger-background)',
              backgroundHover: 'var(--bolt-elements-button-danger-backgroundHover)',
              text: 'var(--bolt-elements-button-danger-text)',
            },
          },
          item: {
            contentDefault: 'var(--bolt-elements-item-contentDefault)',
            contentActive: 'var(--bolt-elements-item-contentActive)',
            contentAccent: 'var(--bolt-elements-item-contentAccent)',
            contentDanger: 'var(--bolt-elements-item-contentDanger)',
            backgroundDefault: 'var(--bolt-elements-item-backgroundDefault)',
            backgroundActive: 'var(--bolt-elements-item-backgroundActive)',
            backgroundAccent: 'var(--bolt-elements-item-backgroundAccent)',
            backgroundDanger: 'var(--bolt-elements-item-backgroundDanger)',
          },
          actions: {
            background: 'var(--bolt-elements-actions-background)',
            code: {
              background: 'var(--bolt-elements-actions-code-background)',
            },
          },
          artifacts: {
            background: 'var(--bolt-elements-artifacts-background)',
            backgroundHover: 'var(--bolt-elements-artifacts-backgroundHover)',
            borderColor: 'var(--bolt-elements-artifacts-borderColor)',
            inlineCode: {
              background: 'var(--bolt-elements-artifacts-inlineCode-background)',
              text: 'var(--bolt-elements-artifacts-inlineCode-text)',
            },
          },
          messages: {
            background: 'var(--bolt-elements-messages-background)',
            linkColor: 'var(--bolt-elements-messages-linkColor)',
            code: {
              background: 'var(--bolt-elements-messages-code-background)',
            },
            inlineCode: {
              background: 'var(--bolt-elements-messages-inlineCode-background)',
              text: 'var(--bolt-elements-messages-inlineCode-text)',
            },
          },
          icon: {
            success: 'var(--bolt-elements-icon-success)',
            error: 'var(--bolt-elements-icon-error)',
            primary: 'var(--bolt-elements-icon-primary)',
            secondary: 'var(--bolt-elements-icon-secondary)',
            tertiary: 'var(--bolt-elements-icon-tertiary)',
          },
          preview: {
            addressBar: {
              background: 'var(--bolt-elements-preview-addressBar-background)',
              backgroundHover: 'var(--bolt-elements-preview-addressBar-backgroundHover)',
              backgroundActive: 'var(--bolt-elements-preview-addressBar-backgroundActive)',
              text: 'var(--bolt-elements-preview-addressBar-text)',
              textActive: 'var(--bolt-elements-preview-addressBar-textActive)',
            },
          },
          terminals: {
            background: 'var(--bolt-elements-terminals-background)',
            buttonBackground: 'var(--bolt-elements-terminals-buttonBackground)',
          },
          dividerColor: 'var(--bolt-elements-dividerColor)',
          loader: {
            background: 'var(--bolt-elements-loader-background)',
            progress: 'var(--bolt-elements-loader-progress)',
          },
          prompt: {
            background: 'var(--bolt-elements-prompt-background)',
          },
          sidebar: {
            dropdownShadow: 'var(--bolt-elements-sidebar-dropdownShadow)',
            buttonBackgroundDefault: 'var(--bolt-elements-sidebar-buttonBackgroundDefault)',
            buttonBackgroundHover: 'var(--bolt-elements-sidebar-buttonBackgroundHover)',
            buttonText: 'var(--bolt-elements-sidebar-buttonText)',
          },
          cta: {
            background: 'var(--bolt-elements-cta-background)',
            text: 'var(--bolt-elements-cta-text)',
          },
        },
      },
    },
  },
  transformers: [transformerDirectives()],
  presets: [
    presetUno({
      dark: {
        light: '[data-theme="light"]',
        dark: '[data-theme="dark"]',
      },
    }),
    presetIcons({
      warn: true,
      collections: {
        ...customIconCollection,
        ph: () => import('@iconify-json/ph/icons.json').then((i) => i.default as any),
        'svg-spinners': () => import('@iconify-json/svg-spinners/icons.json').then((i) => i.default as any),
      },
      unit: 'em',
    }),
  ],
});

/**
 * Generates an alpha palette for a given hex color.
 *
 * @param hex - The hex color code (without alpha) to generate the palette from.
 * @returns An object where keys are opacity percentages and values are hex colors with alpha.
 *
 * Example:
 *
 * ```
 * {
 *   '1': '#FFFFFF03',
 *   '2': '#FFFFFF05',
 *   '3': '#FFFFFF08',
 * }
 * ```
 */
function generateAlphaPalette(hex: string) {
  return [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].reduce(
    (acc, opacity) => {
      const alpha = Math.round((opacity / 100) * 255)
        .toString(16)
        .padStart(2, '0');

      acc[opacity] = `${hex}${alpha}`;

      return acc;
    },
    {} as Record<number, string>,
  );
}
