import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const ignorePatterns = [
  '**/dist/**',
  '**/node_modules/**',
  '**/.nuxt/**',
  '**/.output/**',
]

function restrictedImportBoundaries(files, patterns) {
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns,
        },
      ],
    },
  }
}

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ignorePatterns,
  },
  {
    rules: {
      // Allow intentionally unused variables/parameters prefixed with `_`.
      // This convention is used throughout the codebase (e.g. `for (const _ of iter)`
      // to consume an async iterator without naming the yielded value).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  restrictedImportBoundaries(['packages/**/*.ts'], [
    {
      group: ['@axiom/core/src/*'],
      message:
        'Do not deep-import from @axiom/core/src. Use the public @axiom/core boundary exports.',
    },
  ]),

  // Core must stay platform-agnostic.
  restrictedImportBoundaries(['packages/core/src/**/*.ts'], [
    {
      group: [
        '@axiom/web-backend',
        '@axiom/web-backend/*',
        '@axiom/web-frontend',
        '@axiom/web-frontend/*',
        '@axiom/telegram',
        '@axiom/telegram/*',
      ],
      message:
        'packages/core must not depend on platform packages (web-backend, web-frontend, telegram).',
    },
  ]),

  // Frontend must not depend on backend/telegram internals.
  restrictedImportBoundaries(['packages/web-frontend/app/**/*.ts'], [
    {
      group: [
        '@axiom/web-backend',
        '@axiom/web-backend/*',
        '@axiom/telegram',
        '@axiom/telegram/*',
      ],
      message:
        'packages/web-frontend must not depend on backend or telegram package internals.',
    },
  ]),

  // Telegram package stays isolated from web package internals.
  restrictedImportBoundaries(['packages/telegram/src/**/*.ts'], [
    {
      group: [
        '@axiom/web-backend',
        '@axiom/web-backend/*',
        '@axiom/web-frontend',
        '@axiom/web-frontend/*',
      ],
      message:
        'packages/telegram must stay isolated from web-backend and web-frontend internals.',
    },
  ]),

  // Lock canonical backend module entrypoints for migrated domains.
  restrictedImportBoundaries(['packages/web-backend/src/**/*.ts'], [
    {
      group: [
        '**/routes/providers.js',
        '**/routes/settings.js',
        '**/routes/tasks.js',
        '**/routes/memory.js',
      ],
      message:
        'Use canonical backend module routes in src/api/modules/<domain>/route.js. Legacy route adapters are not allowed.',
    },
  ]),

  // Backend target structure: route -> controller -> service -> schema/mapper.
  restrictedImportBoundaries(
    [
      'packages/web-backend/src/api/modules/**/route/**/*.ts',
      'packages/web-backend/src/api/modules/**/route.ts',
    ],
    [
      {
        group: [
          '**/service',
          '**/service/**',
          '**/*.service',
          '**/schema',
          '**/schema/**',
          '**/*.schema',
          '**/mapper',
          '**/mapper/**',
          '**/*.mapper',
        ],
        message:
          'Route layer must not import service/schema/mapper directly. Route -> controller only.',
      },
    ],
  ),
  restrictedImportBoundaries(
    [
      'packages/web-backend/src/api/modules/**/controller/**/*.ts',
      'packages/web-backend/src/api/modules/**/controller.ts',
    ],
    [
      {
        group: ['**/route', '**/route/**', '**/*.route'],
        message: 'Controller layer must not import route layer.',
      },
    ],
  ),
  restrictedImportBoundaries(
    [
      'packages/web-backend/src/api/modules/**/service/**/*.ts',
      'packages/web-backend/src/api/modules/**/service.ts',
    ],
    [
      {
        group: [
          '**/route',
          '**/route/**',
          '**/*.route',
          '**/controller',
          '**/controller/**',
          '**/*.controller',
        ],
        message: 'Service layer must not import route/controller layers.',
      },
    ],
  ),
  restrictedImportBoundaries(
    [
      'packages/web-backend/src/api/modules/**/schema/**/*.ts',
      'packages/web-backend/src/api/modules/**/schema.ts',
      'packages/web-backend/src/api/modules/**/mapper/**/*.ts',
      'packages/web-backend/src/api/modules/**/mapper.ts',
    ],
    [
      {
        group: [
          '**/route',
          '**/route/**',
          '**/*.route',
          '**/controller',
          '**/controller/**',
          '**/*.controller',
          '**/service',
          '**/service/**',
          '**/*.service',
        ],
        message:
          'Schema/mapper layer must stay transport-focused and must not depend on route/controller/service layers.',
      },
    ],
  ),

  // Frontend target structure boundaries (for incoming refactor slices).
  restrictedImportBoundaries(['packages/web-frontend/app/features/**/*.ts'], [
    {
      group: ['~/pages/**', '../pages/**', '../../pages/**'],
      message: 'Feature modules must not import page orchestrators.',
    },
  ]),
  restrictedImportBoundaries(['packages/web-frontend/app/api/**/*.ts'], [
    {
      group: [
        '~/pages/**',
        '~/features/**',
        '~/components/**',
        '../pages/**',
        '../features/**',
        '../components/**',
        '../../pages/**',
        '../../features/**',
        '../../components/**',
      ],
      message:
        'Frontend API layer must stay transport-focused and must not import pages/features/components.',
    },
  ]),
)
