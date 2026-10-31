import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';

// Globals provided by GJS and by GNOME Shell to extensions.
const gjsGlobals = {
    global: 'readonly',
    console: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        plugins: {'@stylistic': stylistic},
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': ['error', 'always'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
            '@stylistic/indent': ['error', 4, {SwitchCase: 1}],
            '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/comma-dangle': ['error', 'always-multiline'],
            '@stylistic/object-curly-spacing': ['error', 'never'],
            '@stylistic/arrow-parens': ['error', 'as-needed'],
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/eol-last': 'error',
        },
    },
];
