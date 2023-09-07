module.exports = {
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint", "mocha"],
    extends: [
        'eslint:recommended',
        'prettier',
        'plugin:import/typescript',
        "plugin:mocha/recommended",
    ],
    rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/naming-convention': [
            'error',
            {
                selector: 'variable',
                format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
            },
        ],
        "mocha/no-skipped-tests": "error",
        "mocha/no-exclusive-tests": "error"
    },
};
