import nextjs from '@portal/config/eslint/nextjs';
export default [...nextjs, { ignores: ['.next/**', '.next-dev/**', 'out/**', 'scripts/**', 'next-env.d.ts'] }];
