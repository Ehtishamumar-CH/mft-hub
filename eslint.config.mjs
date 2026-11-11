import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'cdk.out/**', 'lambdas/**', '**/*.js', '**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
